//! A file's history: its versions, each one downloadable, and an old one brought back.
//!
//! Every upload of a new version and every save from the office editor keeps the previous bytes, so
//! the history is already there. Restoring an old version does not move the file back in time: it
//! adds a version that is a copy of the old one, so the history stays a straight line and nothing in
//! it is lost. The copy shares the old version's stored object (the trash's erase knows to keep an
//! object while a living version uses it).

use axum::extract::{Path, State};
use axum::response::Response;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, TransactionTrait,
};
use serde::Serialize;
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::file_versions;
use crate::state::AppState;

use super::authz;
use super::dto::{rfc3339, FileDto};
use super::error::FileError;

/// One version of a file.
#[derive(Debug, Serialize, ToSchema)]
pub struct VersionDto {
    pub id: Uuid,
    pub version_no: i32,
    pub size_bytes: i64,
    pub mime_type: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_name: Option<String>,
    /// The version the file serves now.
    pub current: bool,
}

/// `GET /api/v1/files/{file_id}/versions`: a file's versions, newest first.
#[utoipa::path(
    get,
    path = "/api/v1/files/{file_id}/versions",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File id")),
    responses(
        (status = 200, description = "The versions", body = [VersionDto]),
        (status = 403, description = "No access to the file")
    )
)]
pub async fn list_versions(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
) -> Result<Json<Vec<VersionDto>>, FileError> {
    let access = authz::ensure_readable(&state.db, file_id, session.user_id).await?;
    let versions = file_versions::Entity::find()
        .filter(file_versions::Column::FileId.eq(file_id))
        .order_by_desc(file_versions::Column::VersionNo)
        .all(&state.db)
        .await?;
    let names = super::load_names(
        &state.db,
        versions.iter().filter_map(|v| v.created_by).collect(),
    )
    .await?;
    Ok(Json(
        versions
            .into_iter()
            .map(|v| VersionDto {
                id: v.id,
                version_no: v.version_no,
                size_bytes: v.size_bytes,
                mime_type: v.mime_type,
                created_at: rfc3339(v.created_at),
                created_by_id: v.created_by,
                created_by_name: v.created_by.and_then(|id| names.get(&id).cloned()),
                current: access.file.current_version_id == Some(v.id),
            })
            .collect(),
    ))
}

/// `GET /api/v1/files/{file_id}/versions/{version_id}/download`: one version's bytes.
#[utoipa::path(
    get,
    path = "/api/v1/files/{file_id}/versions/{version_id}/download",
    tag = "files",
    params(
        ("file_id" = Uuid, Path, description = "File id"),
        ("version_id" = Uuid, Path, description = "Version id")
    ),
    responses(
        (status = 200, description = "The version's bytes"),
        (status = 403, description = "No access to the file"),
        (status = 404, description = "No such version of this file")
    )
)]
pub async fn download_version(
    State(state): State<AppState>,
    session: AuthSession,
    Path((file_id, version_id)): Path<(Uuid, Uuid)>,
) -> Result<Response, FileError> {
    let access = authz::ensure_readable(&state.db, file_id, session.user_id).await?;
    let version = version_of(&state, file_id, version_id).await?;
    let storage = state
        .storage
        .as_ref()
        .ok_or(FileError::StorageUnavailable)?;
    let key = version.storage_key.ok_or(FileError::NotFound)?;
    let bytes = storage.get(&key).await?;
    super::download::build_response(
        bytes,
        &version.mime_type,
        "attachment",
        &access.file.name,
        false,
    )
}

/// `POST /api/v1/files/{file_id}/versions/{version_id}/restore`: make an old version the newest.
#[utoipa::path(
    post,
    path = "/api/v1/files/{file_id}/versions/{version_id}/restore",
    tag = "files",
    params(
        ("file_id" = Uuid, Path, description = "File id"),
        ("version_id" = Uuid, Path, description = "Version to bring back")
    ),
    responses(
        (status = 200, description = "The file, its new version a copy of the old one", body = FileDto),
        (status = 403, description = "Not allowed to replace this file"),
        (status = 404, description = "No such version of this file")
    )
)]
pub async fn restore_version(
    State(state): State<AppState>,
    session: AuthSession,
    Path((file_id, version_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<FileDto>, FileError> {
    // The same right as replacing the file by hand: it changes what everyone opens.
    let access = authz::ensure_editable(&state.db, file_id, session.user_id).await?;
    if access.file.kind == "folder" {
        return Err(FileError::BadRequest("a folder has no versions"));
    }
    let old = version_of(&state, file_id, version_id).await?;
    let latest = file_versions::Entity::find()
        .filter(file_versions::Column::FileId.eq(file_id))
        .order_by_desc(file_versions::Column::VersionNo)
        .one(&state.db)
        .await?
        .map(|v| v.version_no)
        .unwrap_or(0);

    let now = OffsetDateTime::now_utc();
    let new_id = Uuid::new_v4();
    let txn = state.db.begin().await?;
    file_versions::ActiveModel {
        id: Set(new_id),
        file_id: Set(file_id),
        version_no: Set(latest + 1),
        size_bytes: Set(old.size_bytes),
        content_hash: Set(old.content_hash.clone()),
        storage_key: Set(old.storage_key.clone()),
        thumbnail_key: Set(old.thumbnail_key.clone()),
        mime_type: Set(old.mime_type.clone()),
        image_width: Set(old.image_width),
        image_height: Set(old.image_height),
        created_by: Set(Some(session.user_id)),
        created_at: Set(now),
    }
    .insert(&txn)
    .await?;
    super::versions::point_to_version(&txn, file_id, new_id, old.size_bytes, now).await?;
    txn.commit().await?;

    let row = crate::entities::files::Entity::find_by_id(file_id)
        .one(&state.db)
        .await?
        .ok_or(FileError::Internal)?;
    let dto = super::hydrate_files(&state.db, vec![row.clone()])
        .await?
        .pop()
        .ok_or(FileError::Internal)?;
    super::versions::publish_updated(&state, &row, session.user_id, &dto).await;
    Ok(Json(dto))
}

/// A version of this file, or not found (a version id of another file is not this file's).
async fn version_of(
    state: &AppState,
    file_id: Uuid,
    version_id: Uuid,
) -> Result<file_versions::Model, FileError> {
    file_versions::Entity::find_by_id(version_id)
        .one(&state.db)
        .await?
        .filter(|v| v.file_id == file_id)
        .ok_or(FileError::NotFound)
}
