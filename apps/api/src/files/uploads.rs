//! Upload endpoints: create a file (first version) and append a new version.
//!
//! Bytes arrive as `multipart/form-data` and are proxied to the object store by the server, which
//! validates the size, sniffs the real MIME (never trusting the client), classifies the kind, hashes
//! the content, and for images records dimensions and stores a thumbnail. Object keys are opaque and
//! server-generated (`spaces/{space}/{file}/{version}`), so a filename can never influence the key.

use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    TransactionTrait,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{file_versions, files};
use crate::state::AppState;

use super::authz;
use super::dto::FileDto;
use super::error::FileError;
use super::mime;
use super::tree::clean_name;
use super::versions::{self, insert_version, point_to_version, store_version_object};

/// The parsed parts of a multipart upload.
struct UploadPayload {
    name: Option<String>,
    folder_id: Option<Uuid>,
    data: Vec<u8>,
    /// What to do about a duplicate the person has been told of (see [`upload_file`]).
    on_conflict: Option<OnConflict>,
}

/// The answer to a duplicate, sent back with the same bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OnConflict {
    /// The upload becomes the next version of the file it collides with.
    Replace,
    /// The upload is kept beside it, under the next free numbered name ("Devis (1).pdf").
    KeepBoth,
}

/// What an upload into the space's tree collides with: the same file, the same name, the same bytes.
enum Duplicate {
    /// A file of the same name in the same folder, with the same bytes.
    File(files::Model),
    /// A file of the same name in the same folder, with other bytes.
    Name(files::Model),
    /// The same bytes under another name or in another folder.
    Content(files::Model),
}

/// A `409` for a duplicate: why, the file already there, and the folders it is in (root first).
#[derive(Serialize)]
struct DuplicateBody {
    error: &'static str,
    /// `same_file`, `same_name` or `same_content`.
    reason: &'static str,
    existing: FileDto,
    path: Vec<String>,
}

/// An upload's answer: the file, and `merged` when the bytes went to a file already there as its
/// next version rather than to a new one.
#[derive(Serialize)]
struct UploadedBody {
    #[serde(flatten)]
    file: FileDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    merged: Option<&'static str>,
}

/// `POST /api/v1/spaces/{space_id}/files`: upload a new file (its first version).
#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/files",
    tag = "files",
    params(("space_id" = Uuid, Path, description = "Space id")),
    request_body(content = String, description = "multipart/form-data: file, optional folder_id, name", content_type = "multipart/form-data"),
    responses(
        (status = 201, description = "File created, or the next version of the file replaced", body = FileDto),
        (status = 200, description = "The same bytes were already in the space: they became that file's next version (`merged`)", body = FileDto),
        (status = 400, description = "Missing file or invalid folder"),
        (status = 409, description = "A duplicate: the same name in the folder, or the same bytes in the space the caller may not version"),
        (status = 403, description = "Not a member of the space"),
        (status = 413, description = "File exceeds the maximum upload size"),
        (status = 503, description = "Object storage not configured")
    )
)]
pub async fn upload_file(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    multipart: Multipart,
) -> Result<Response, FileError> {
    authz::ensure_space_files_member(&state.db, space_id, session.user_id).await?;
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;

    let payload = collect_upload(multipart, state.config.upload_max_bytes).await?;
    if let Some(folder_id) = payload.folder_id {
        let folder = files::Entity::find_by_id(folder_id)
            .one(&state.db)
            .await?
            .ok_or(FileError::BadRequest("folder not found"))?;
        if folder.space_id != space_id || folder.kind != "folder" || folder.deleted_at.is_some() {
            return Err(FileError::BadRequest("invalid folder"));
        }
    }

    let mut name = default_name(payload.name);

    // No duplicates in the space's tree, however long ago the first copy came (decided with Lilou,
    // 2026-10-19): the same name in the folder is refused until the person chooses (another name,
    // or replacing a file whose bytes are the same), and the same bytes elsewhere become the next
    // version of the file that already holds them.
    let hash = Sha256::digest(&payload.data).to_vec();
    match (
        find_duplicate(&state.db, space_id, payload.folder_id, &name, &hash).await?,
        payload.on_conflict,
    ) {
        (
            Some(Duplicate::File(existing) | Duplicate::Name(existing)),
            Some(OnConflict::Replace),
        ) => {
            let access = authz::ensure_editable(&state.db, existing.id, session.user_id).await?;
            let dto =
                versions::add_version(&state, access.file, session.user_id, &payload.data).await?;
            return Ok((StatusCode::CREATED, Json(dto)).into_response());
        }
        (Some(Duplicate::File(_) | Duplicate::Name(_)), Some(OnConflict::KeepBoth)) => {
            name = free_name(&state.db, space_id, payload.folder_id, &name).await?;
        }
        (Some(Duplicate::File(existing)), None) => {
            return duplicate(&state.db, "same_file", existing).await;
        }
        (Some(Duplicate::Name(existing)), None) => {
            return duplicate(&state.db, "same_name", existing).await;
        }
        (Some(Duplicate::Content(existing)), None | Some(OnConflict::Replace)) => {
            // Someone who may not change that file is told where it is rather than versioning it.
            return match authz::ensure_editable(&state.db, existing.id, session.user_id).await {
                Ok(access) => {
                    let file =
                        versions::add_version(&state, access.file, session.user_id, &payload.data)
                            .await?;
                    Ok(Json(UploadedBody {
                        file,
                        merged: Some("version"),
                    })
                    .into_response())
                }
                Err(_) => duplicate(&state.db, "same_content", existing).await,
            };
        }
        (Some(Duplicate::Content(_)), Some(OnConflict::KeepBoth)) | (None, _) => {}
    }

    let file_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let stored = store_version_object(
        storage,
        &state.config,
        space_id,
        file_id,
        version_id,
        &payload.data,
    )
    .await?;
    let kind = mime::kind_for_mime(&stored.mime_type).to_owned();
    let now = OffsetDateTime::now_utc();

    let txn = state.db.begin().await?;
    let created = files::ActiveModel {
        id: Set(file_id),
        space_id: Set(space_id),
        owner_id: Set(Some(session.user_id)),
        name: Set(name),
        kind: Set(kind),
        parent_folder_id: Set(payload.folder_id),
        size_bytes: Set(stored.size_bytes),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(&txn)
    .await?;
    insert_version(&txn, file_id, version_id, 1, session.user_id, now, &stored).await?;
    point_to_version(&txn, file_id, version_id, stored.size_bytes, now).await?;
    txn.commit().await?;

    let dto = single_dto(&state.db, file_id).await?;
    // The others in the space see it arrive, as they see a new version: a folder open on someone
    // else's screen had to be reloaded to show what a colleague had just put in it.
    versions::publish_updated(&state, &created, session.user_id, &dto).await;
    Ok((StatusCode::CREATED, Json(dto)).into_response())
}

/// The space's live files a member sees in its tree: not in the trash, not a private conversation's,
/// not folders.
fn tree_files(space_id: Uuid) -> sea_orm::Select<files::Entity> {
    files::Entity::find()
        .filter(files::Column::SpaceId.eq(space_id))
        .filter(files::Column::DeletedAt.is_null())
        .filter(files::Column::ConversationId.is_null())
        .filter(files::Column::Kind.ne("folder"))
}

/// The files of one folder (the root when `None`).
fn in_folder(
    select: sea_orm::Select<files::Entity>,
    folder_id: Option<Uuid>,
) -> sea_orm::Select<files::Entity> {
    match folder_id {
        Some(id) => select.filter(files::Column::ParentFolderId.eq(id)),
        None => select.filter(files::Column::ParentFolderId.is_null()),
    }
}

/// What an upload of `name` with bytes hashing to `hash` into `folder_id` collides with. Names are
/// compared without regard to case, as the apps compare them.
async fn find_duplicate(
    db: &DatabaseConnection,
    space_id: Uuid,
    folder_id: Option<Uuid>,
    name: &str,
    hash: &[u8],
) -> Result<Option<Duplicate>, FileError> {
    let lowered = name.to_lowercase();
    let same_name = in_folder(tree_files(space_id), folder_id)
        .all(db)
        .await?
        .into_iter()
        .find(|file| file.name.to_lowercase() == lowered);
    if let Some(existing) = same_name {
        let same_bytes = match existing.current_version_id {
            Some(version_id) => file_versions::Entity::find_by_id(version_id)
                .one(db)
                .await?
                .and_then(|version| version.content_hash)
                .is_some_and(|stored| stored == hash),
            None => false,
        };
        return Ok(Some(if same_bytes {
            Duplicate::File(existing)
        } else {
            Duplicate::Name(existing)
        }));
    }
    let versions: Vec<Uuid> = file_versions::Entity::find()
        .filter(file_versions::Column::ContentHash.eq(hash.to_vec()))
        .all(db)
        .await?
        .into_iter()
        .map(|version| version.id)
        .collect();
    if versions.is_empty() {
        return Ok(None);
    }
    Ok(tree_files(space_id)
        .filter(files::Column::CurrentVersionId.is_in(versions))
        .one(db)
        .await?
        .map(Duplicate::Content))
}

/// `name`, or the first of "name (1).ext", "name (2).ext"... that no file of the folder has.
async fn free_name(
    db: &DatabaseConnection,
    space_id: Uuid,
    folder_id: Option<Uuid>,
    name: &str,
) -> Result<String, FileError> {
    let taken: Vec<String> = in_folder(tree_files(space_id), folder_id)
        .all(db)
        .await?
        .into_iter()
        .map(|file| file.name.to_lowercase())
        .collect();
    Ok(numbered_name(name, &taken))
}

/// The first numbered form of `name` absent from `taken` (lowercased names).
fn numbered_name(name: &str, taken: &[String]) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    (1..)
        .map(|n| format!("{stem} ({n}){ext}"))
        .find(|candidate| !taken.contains(&candidate.to_lowercase()))
        .unwrap_or_else(|| name.to_owned())
}

/// The `409` of a duplicate, naming the file already there and where it is.
async fn duplicate(
    db: &DatabaseConnection,
    reason: &'static str,
    existing: files::Model,
) -> Result<Response, FileError> {
    let mut path = Vec::new();
    let mut parent = existing.parent_folder_id;
    // A folder chain is short; the bound only guards against a cycle.
    for _ in 0..64 {
        let Some(id) = parent else { break };
        let Some(folder) = files::Entity::find_by_id(id).one(db).await? else {
            break;
        };
        path.push(folder.name.clone());
        parent = folder.parent_folder_id;
    }
    path.reverse();
    let existing = single_dto(db, existing.id).await?;
    Ok((
        StatusCode::CONFLICT,
        Json(DuplicateBody {
            error: "duplicate",
            reason,
            existing,
            path,
        }),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::numbered_name;

    #[test]
    fn a_kept_copy_takes_the_next_free_number() {
        assert_eq!(
            numbered_name("Devis.pdf", &["devis.pdf".into()]),
            "Devis (1).pdf"
        );
        assert_eq!(
            numbered_name("Devis.pdf", &["devis.pdf".into(), "devis (1).pdf".into()]),
            "Devis (2).pdf"
        );
        assert_eq!(numbered_name("Notes", &["notes".into()]), "Notes (1)");
        assert_eq!(numbered_name(".env", &[".env".into()]), ".env (1)");
    }
}

/// Well-known marker for the folder public attachments land in. Looked up by this and never by its
/// name, which is an ordinary folder name a user may change.
const ATTACHMENTS_KEY: &str = "attachments";

/// `POST /api/v1/conversations/{conversation_id}/attachments`: upload a file to attach to a message.
///
/// Uploading through the conversation rather than the space is what decides the file's audience.
/// A public channel's history is already open to the space, so its attachments join the space's
/// files, in a folder rather than at the root. A private channel or a direct message is not, so its
/// attachments stay out of the tree and are readable only by that conversation's participants.
/// Deciding this at send time instead would mean the bytes were already stored under the wrong rule.
#[utoipa::path(
    post,
    path = "/api/v1/conversations/{conversation_id}/attachments",
    tag = "files",
    params(("conversation_id" = Uuid, Path, description = "Conversation id")),
    request_body(content = String, description = "multipart/form-data: file, optional name", content_type = "multipart/form-data"),
    responses(
        (status = 201, description = "File stored, ready to attach", body = FileDto),
        (status = 400, description = "Missing file"),
        (status = 403, description = "No access to the conversation, or it is read-only"),
        (status = 413, description = "File exceeds the maximum upload size"),
        (status = 503, description = "Object storage not configured")
    )
)]
pub async fn upload_attachment(
    State(state): State<AppState>,
    session: AuthSession,
    Path(conversation_id): Path<Uuid>,
    multipart: Multipart,
) -> Result<(StatusCode, Json<FileDto>), FileError> {
    let access = authz::conversation_access(&state.db, conversation_id, session.user_id).await?;
    // An archived channel takes no new message, so it takes no attachment for one either.
    if !access.is_postable() {
        return Err(FileError::Forbidden);
    }
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;
    let payload = collect_upload(multipart, state.config.upload_max_bytes).await?;

    let space_id = access.space_id;
    let public_channel = access.channel_type.as_deref() == Some("public");
    let folder_id = if public_channel {
        Some(
            attachments_folder(&state.db, space_id, Some(session.user_id))
                .await
                .map_err(|error| {
                    tracing::error!(%error, "could not create or find the attachments folder");
                    FileError::Internal
                })?,
        )
    } else {
        None
    };

    let name = default_name(payload.name);
    let file_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let stored = store_version_object(
        storage,
        &state.config,
        space_id,
        file_id,
        version_id,
        &payload.data,
    )
    .await?;
    let kind = mime::kind_for_mime(&stored.mime_type).to_owned();
    let now = OffsetDateTime::now_utc();

    let txn = state.db.begin().await?;
    files::ActiveModel {
        id: Set(file_id),
        space_id: Set(space_id),
        owner_id: Set(Some(session.user_id)),
        name: Set(name),
        kind: Set(kind),
        parent_folder_id: Set(folder_id),
        // The whole audience decision, in one column.
        conversation_id: Set((!public_channel).then_some(conversation_id)),
        size_bytes: Set(stored.size_bytes),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(&txn)
    .await?;
    insert_version(&txn, file_id, version_id, 1, session.user_id, now, &stored).await?;
    point_to_version(&txn, file_id, version_id, stored.size_bytes, now).await?;
    txn.commit().await?;

    let dto = single_dto(&state.db, file_id).await?;
    Ok((StatusCode::CREATED, Json(dto)))
}

/// The space's attachments folder, created on first use.
///
/// Found by `system_key` so that renaming it keeps it working, and guarded by a unique index so two
/// simultaneous first uploads cannot each create one.
///
/// An import files a public channel's attachments here as well, so that an imported attachment
/// sits where the same file sent here would. It creates the folder with no owner when it is the
/// first to need it: nobody uploaded anything, and a folder the product maintains is not anyone's.
pub(crate) async fn attachments_folder<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    owner_id: Option<Uuid>,
) -> Result<Uuid, sea_orm::DbErr> {
    if let Some(existing) = files::Entity::find()
        .filter(files::Column::SpaceId.eq(space_id))
        .filter(files::Column::SystemKey.eq(ATTACHMENTS_KEY))
        .filter(files::Column::DeletedAt.is_null())
        .one(db)
        .await?
    {
        return Ok(existing.id);
    }

    let id = Uuid::new_v4();
    let now = OffsetDateTime::now_utc();
    let created = files::ActiveModel {
        id: Set(id),
        space_id: Set(space_id),
        owner_id: Set(owner_id),
        // A display name, in the product's language like every other name a person reads. The marker
        // above is what identifies it.
        name: Set("Pièces jointes".to_owned()),
        kind: Set("folder".to_owned()),
        system_key: Set(Some(ATTACHMENTS_KEY.to_owned())),
        size_bytes: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(db)
    .await;

    match created {
        Ok(_) => Ok(id),
        // Lost the race against another first upload: the unique index rejected the second one, so
        // read back the winner rather than failing an upload over it.
        Err(error) => files::Entity::find()
            .filter(files::Column::SpaceId.eq(space_id))
            .filter(files::Column::SystemKey.eq(ATTACHMENTS_KEY))
            .one(db)
            .await?
            .map(|folder| folder.id)
            .ok_or(error),
    }
}

/// `POST /api/v1/files/{file_id}/versions`: upload a new version of an existing file.
#[utoipa::path(
    post,
    path = "/api/v1/files/{file_id}/versions",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File id")),
    request_body(content = String, description = "multipart/form-data: file", content_type = "multipart/form-data"),
    responses(
        (status = 201, description = "New version stored", body = FileDto),
        (status = 400, description = "Missing file, or the target is a folder"),
        (status = 403, description = "Not allowed to modify this file"),
        (status = 413, description = "File exceeds the maximum upload size"),
        (status = 503, description = "Object storage not configured")
    )
)]
pub async fn upload_version(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
    multipart: Multipart,
) -> Result<(StatusCode, Json<FileDto>), FileError> {
    let access = authz::ensure_editable(&state.db, file_id, session.user_id).await?;
    let file = access.file;
    if file.kind == "folder" {
        return Err(FileError::BadRequest("cannot add a version to a folder"));
    }
    if state.storage.is_none() {
        return Err(FileError::StorageUnavailable);
    }
    let payload = collect_upload(multipart, state.config.upload_max_bytes).await?;
    let dto = versions::add_version(&state, file, session.user_id, &payload.data).await?;
    Ok((StatusCode::CREATED, Json(dto)))
}

/// Read the multipart body into memory, enforcing the size cap on the file field.
async fn collect_upload(
    mut multipart: Multipart,
    max_bytes: u64,
) -> Result<UploadPayload, FileError> {
    let mut name: Option<String> = None;
    let mut folder_id: Option<Uuid> = None;
    let mut data: Option<Vec<u8>> = None;
    let mut on_conflict: Option<OnConflict> = None;

    while let Some(field) = multipart.next_field().await? {
        // Read the field's identity before consuming it (the accessors borrow, the readers move).
        let field_name = field.name().map(|s| s.to_owned());
        let file_name = field.file_name().map(|s| s.to_owned());
        match field_name.as_deref() {
            Some("folder_id") => {
                let text = field.text().await?;
                if !text.trim().is_empty() {
                    folder_id = Some(
                        Uuid::parse_str(text.trim())
                            .map_err(|_| FileError::BadRequest("invalid folder_id"))?,
                    );
                }
            }
            Some("on_conflict") => {
                on_conflict = match field.text().await?.trim() {
                    "replace" => Some(OnConflict::Replace),
                    "keep_both" => Some(OnConflict::KeepBoth),
                    _ => return Err(FileError::BadRequest("invalid on_conflict")),
                };
            }
            Some("name") => {
                let text = field.text().await?;
                if !text.trim().is_empty() {
                    name = Some(text);
                }
            }
            Some("file") => {
                if name.is_none() {
                    name = file_name;
                }
                let bytes = field.bytes().await?;
                if bytes.len() as u64 > max_bytes {
                    return Err(FileError::PayloadTooLarge(
                        "file exceeds the maximum upload size",
                    ));
                }
                data = Some(bytes.to_vec());
            }
            other => {
                // Refused rather than drained. A field this handler does not know is a client
                // sending something it believes matters, and swallowing it turns a mismatch into
                // silence: an upload answering 201 with the folder it was given quietly dropped.
                let _ = field.bytes().await?;
                tracing::warn!(field = ?other, "unknown field in a file upload");
                return Err(FileError::BadRequest("unknown field in the upload"));
            }
        }
    }

    let data = data.ok_or(FileError::BadRequest("no file field in the upload"))?;
    if data.is_empty() {
        return Err(FileError::BadRequest("the uploaded file is empty"));
    }
    Ok(UploadPayload {
        name,
        folder_id,
        data,
        on_conflict,
    })
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

/// Fall back to a generic name when the upload carried none usable.
fn default_name(raw: Option<String>) -> String {
    let cleaned = raw.map(|r| clean_name(&r)).unwrap_or_default();
    if cleaned.is_empty() {
        "file".to_owned()
    } else {
        cleaned
    }
}
