//! Upload endpoints: create a file (first version) and append a new version.
//!
//! Bytes arrive as `multipart/form-data` and are proxied to the object store by the server, which
//! validates the size, sniffs the real MIME (never trusting the client), classifies the kind, hashes
//! the content, and for images records dimensions and stores a thumbnail. Object keys are opaque and
//! server-generated (`spaces/{space}/{file}/{version}`), so a filename can never influence the key.

use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    TransactionTrait,
};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::files;
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
}

/// `POST /api/v1/spaces/{space_id}/files`: upload a new file (its first version).
#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/files",
    tag = "files",
    params(("space_id" = Uuid, Path, description = "Space id")),
    request_body(content = String, description = "multipart/form-data: file, optional folder_id, name", content_type = "multipart/form-data"),
    responses(
        (status = 201, description = "File created", body = FileDto),
        (status = 400, description = "Missing file or invalid folder"),
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
) -> Result<(StatusCode, Json<FileDto>), FileError> {
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
    Ok((StatusCode::CREATED, Json(dto)))
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
