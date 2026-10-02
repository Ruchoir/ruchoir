//! Writing a file's bytes: the one path every new version goes through, whether a member uploads it
//! by hand or the office editor saves it, and the creation of a file from bytes the server already
//! holds (a blank document, a converted copy).
//!
//! Everything here sniffs, hashes, caps and stores the same way, and tells the people who can see
//! the file that it changed (`files.updated`).

use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, IntoActiveModel, QueryFilter,
    QueryOrder, TransactionTrait,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::config::Config;
use crate::entities::{file_versions, files, space_members};
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;
use crate::storage::S3Store;

use super::dto::FileDto;
use super::error::FileError;
use super::mime;
use super::thumbnail::{self, THUMBNAIL_MIME};

/// The payload of `files.updated`.
#[derive(Serialize)]
pub(crate) struct FilesUpdatedEvent {
    pub space_id: Uuid,
    pub file: FileDto,
    /// The conversation the file belongs to, when it is a private conversation's: such a file is
    /// not in the space's folders, and a client must not list it there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<Uuid>,
}

/// A file the server creates from bytes it holds.
pub(crate) struct NewFile {
    pub space_id: Uuid,
    pub folder_id: Option<Uuid>,
    pub conversation_id: Option<Uuid>,
    pub owner: Uuid,
    pub name: String,
}

/// Store `data` as the next version of `file`, by `author`, and tell the file's audience.
pub(crate) async fn add_version(
    state: &AppState,
    file: files::Model,
    author: Uuid,
    data: &[u8],
) -> Result<FileDto, FileError> {
    if file.kind == "folder" {
        return Err(FileError::BadRequest("cannot add a version to a folder"));
    }
    if data.len() as u64 > state.config.upload_max_bytes {
        return Err(FileError::PayloadTooLarge(
            "file exceeds the maximum upload size",
        ));
    }
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;

    let next_no = file_versions::Entity::find()
        .filter(file_versions::Column::FileId.eq(file.id))
        .order_by_desc(file_versions::Column::VersionNo)
        .one(&state.db)
        .await?
        .map(|v| v.version_no + 1)
        .unwrap_or(1);

    let file_id = file.id;
    let version_id = Uuid::new_v4();
    let stored = store_version_object(
        storage,
        &state.config,
        file.space_id,
        file_id,
        version_id,
        data,
    )
    .await?;
    let kind = mime::kind_for_mime(&stored.mime_type).to_owned();
    let now = OffsetDateTime::now_utc();

    let txn = state.db.begin().await?;
    insert_version(&txn, file_id, version_id, next_no, author, now, &stored).await?;
    // Keep the file kind in step with its current version, and refresh size/current pointer.
    let mut file_update = file.into_active_model();
    file_update.current_version_id = Set(Some(version_id));
    file_update.size_bytes = Set(stored.size_bytes);
    file_update.kind = Set(kind);
    file_update.updated_at = Set(now);
    let updated = file_update.update(&txn).await?;
    txn.commit().await?;

    let dto = single_dto(&state.db, file_id).await?;
    publish_updated(state, &updated, author, &dto).await;
    Ok(dto)
}

/// Create a file from `data` and tell its audience.
pub(crate) async fn create_file(
    state: &AppState,
    new: NewFile,
    data: &[u8],
) -> Result<FileDto, FileError> {
    if data.len() as u64 > state.config.upload_max_bytes {
        return Err(FileError::PayloadTooLarge(
            "file exceeds the maximum upload size",
        ));
    }
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;
    let file_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let stored = store_version_object(
        storage,
        &state.config,
        new.space_id,
        file_id,
        version_id,
        data,
    )
    .await?;
    let kind = mime::kind_for_mime(&stored.mime_type).to_owned();
    let now = OffsetDateTime::now_utc();

    let txn = state.db.begin().await?;
    let created = files::ActiveModel {
        id: Set(file_id),
        space_id: Set(new.space_id),
        owner_id: Set(Some(new.owner)),
        name: Set(new.name),
        kind: Set(kind),
        parent_folder_id: Set(new.folder_id),
        conversation_id: Set(new.conversation_id),
        size_bytes: Set(stored.size_bytes),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(&txn)
    .await?;
    insert_version(&txn, file_id, version_id, 1, new.owner, now, &stored).await?;
    point_to_version(&txn, file_id, version_id, stored.size_bytes, now).await?;
    txn.commit().await?;

    let dto = single_dto(&state.db, file_id).await?;
    publish_updated(state, &created, new.owner, &dto).await;
    Ok(dto)
}

/// The longest file name, in characters, as `tree::clean_name` caps an uploaded one.
const MAX_NAME_CHARS: usize = 255;

/// The first of `stem.ext`, `stem (2).ext`, `stem (3).ext`… that no live file in the same place
/// carries. Never an existing name: a conversion or a blank document must not hide a file.
pub(crate) async fn free_name(
    db: &DatabaseConnection,
    space_id: Uuid,
    folder_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
    stem: &str,
    ext: &str,
) -> Result<String, FileError> {
    let mut query = files::Entity::find()
        .filter(files::Column::SpaceId.eq(space_id))
        .filter(files::Column::DeletedAt.is_null());
    query = match folder_id {
        Some(folder) => query.filter(files::Column::ParentFolderId.eq(folder)),
        None => query.filter(files::Column::ParentFolderId.is_null()),
    };
    query = match conversation_id {
        Some(conversation) => query.filter(files::Column::ConversationId.eq(conversation)),
        None => query.filter(files::Column::ConversationId.is_null()),
    };
    let taken: std::collections::HashSet<String> = query
        .all(db)
        .await?
        .into_iter()
        .map(|f| f.name.to_lowercase())
        .collect();
    let mut n = 1;
    loop {
        let suffix = if n == 1 {
            format!(".{ext}")
        } else {
            format!(" ({n}).{ext}")
        };
        // Names are capped at 255 characters (see `tree::clean_name`): the stem gives way, never the
        // number or the extension.
        let room = MAX_NAME_CHARS.saturating_sub(suffix.chars().count());
        let stem: String = stem.chars().take(room).collect();
        let candidate = format!("{}{suffix}", stem.trim_end());
        if !taken.contains(&candidate.to_lowercase()) {
            return Ok(candidate);
        }
        n += 1;
    }
}

/// Who may see `file`: the participants of its conversation, or the members of its space other than
/// its guests, who cannot read the space's files (see `authz::ensure_readable`).
pub(crate) async fn file_audience(
    db: &DatabaseConnection,
    file: &files::Model,
    actor: Uuid,
) -> Vec<Uuid> {
    match file.conversation_id {
        Some(conversation_id) => {
            match crate::messaging::authz::ensure_conversation_access(db, conversation_id, actor)
                .await
            {
                Ok(access) => crate::messaging::authz::conversation_audience(db, &access)
                    .await
                    .unwrap_or_default(),
                Err(_) => Vec::new(),
            }
        }
        // The space's members other than its guests. Read directly rather than through the actor,
        // so a change nobody made (an editor's tab lapsing) still reaches them.
        None => space_members::Entity::find()
            .filter(space_members::Column::SpaceId.eq(file.space_id))
            .filter(space_members::Column::Role.ne("guest"))
            .all(db)
            .await
            .map(|rows| rows.into_iter().map(|m| m.user_id).collect())
            .unwrap_or_default(),
    }
}

/// Tell the people who can see `file` that it changed: a new version, a new file, a new folder.
pub(crate) async fn publish_updated(
    state: &AppState,
    file: &files::Model,
    actor: Uuid,
    dto: &FileDto,
) {
    let audience = file_audience(&state.db, file, actor).await;
    state
        .hub
        .publish(
            audience,
            RealtimeEnvelope::files_updated(FilesUpdatedEvent {
                space_id: file.space_id,
                file: dto.clone(),
                conversation_id: file.conversation_id,
            }),
        )
        .await;
}

/// Load a single file as a DTO after a write.
async fn single_dto(db: &DatabaseConnection, file_id: Uuid) -> Result<FileDto, FileError> {
    let row = files::Entity::find_by_id(file_id)
        .one(db)
        .await?
        .ok_or(FileError::Internal)?;
    super::hydrate_files(db, vec![row])
        .await?
        .pop()
        .ok_or(FileError::Internal)
}

/// The stored-object metadata for one version after bytes are written.
pub(super) struct StoredObject {
    pub(super) storage_key: String,
    pub(super) thumbnail_key: Option<String>,
    pub(super) image_width: Option<i32>,
    pub(super) image_height: Option<i32>,
    pub(super) mime_type: String,
    pub(super) size_bytes: i64,
    pub(super) content_hash: Vec<u8>,
}

/// Sniff, thumbnail (for images) and store the bytes for one version, returning its metadata.
pub(super) async fn store_version_object(
    storage: &S3Store,
    config: &Config,
    space_id: Uuid,
    file_id: Uuid,
    version_id: Uuid,
    data: &[u8],
) -> Result<StoredObject, FileError> {
    let mime_type = mime::sniff_mime(data);
    let content_hash = Sha256::digest(data).to_vec();
    let size_bytes = data.len() as i64;
    let storage_key = object_key(space_id, file_id, version_id);

    // Images: record intrinsic dimensions and store a thumbnail. A decode failure is non-fatal: the
    // original bytes are still stored, just without a thumbnail.
    let (image_width, image_height, thumbnail_key) = if mime::is_image(&mime_type) {
        match thumbnail::make_thumbnail(data, config.thumbnail_max_px) {
            Ok(info) => {
                let key = thumbnail_key(&storage_key);
                storage.put(&key, &info.thumbnail, THUMBNAIL_MIME).await?;
                (Some(info.width as i32), Some(info.height as i32), Some(key))
            }
            Err(error) => {
                tracing::warn!(%error, "could not generate a thumbnail; storing without one");
                (None, None, None)
            }
        }
    } else {
        (None, None, None)
    };

    storage.put(&storage_key, data, &mime_type).await?;

    Ok(StoredObject {
        storage_key,
        thumbnail_key,
        image_width,
        image_height,
        mime_type,
        size_bytes,
        content_hash,
    })
}

/// Insert one immutable version row from stored-object metadata.
pub(super) async fn insert_version<C: sea_orm::ConnectionTrait>(
    db: &C,
    file_id: Uuid,
    version_id: Uuid,
    version_no: i32,
    created_by: Uuid,
    now: OffsetDateTime,
    stored: &StoredObject,
) -> Result<(), FileError> {
    file_versions::ActiveModel {
        id: Set(version_id),
        file_id: Set(file_id),
        version_no: Set(version_no),
        size_bytes: Set(stored.size_bytes),
        content_hash: Set(Some(stored.content_hash.clone())),
        storage_key: Set(Some(stored.storage_key.clone())),
        thumbnail_key: Set(stored.thumbnail_key.clone()),
        mime_type: Set(stored.mime_type.clone()),
        image_width: Set(stored.image_width),
        image_height: Set(stored.image_height),
        created_by: Set(Some(created_by)),
        created_at: Set(now),
    }
    .insert(db)
    .await?;
    Ok(())
}

/// Point a fresh file at its first version (app-maintained pointer, no FK).
pub(super) async fn point_to_version<C: sea_orm::ConnectionTrait>(
    db: &C,
    file_id: Uuid,
    version_id: Uuid,
    size_bytes: i64,
    now: OffsetDateTime,
) -> Result<(), FileError> {
    let mut update = files::ActiveModel {
        id: Set(file_id),
        ..Default::default()
    };
    update.current_version_id = Set(Some(version_id));
    update.size_bytes = Set(size_bytes);
    update.updated_at = Set(now);
    update.update(db).await?;
    Ok(())
}

/// Deterministic, opaque object key for a version (never derived from a filename).
pub(super) fn object_key(space_id: Uuid, file_id: Uuid, version_id: Uuid) -> String {
    format!("spaces/{space_id}/{file_id}/{version_id}")
}

/// The thumbnail key derived from an object key.
pub(super) fn thumbnail_key(object_key: &str) -> String {
    format!("{object_key}.thumb")
}
