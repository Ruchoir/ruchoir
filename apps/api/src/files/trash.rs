//! The space's trash: what was removed, waiting to be restored or erased for good.
//!
//! A removal is soft (`deleted_at` on the entry and on everything under a folder) and its root is
//! marked `trashed`: that is the one entry the trash lists, and restoring it brings back what was
//! removed with it, and nothing removed separately. Erasing for good deletes the bytes from the
//! object store and keeps the row as a tombstone (`purged_at`), so a message attachment that pointed
//! at it says "deleted" rather than breaking.
//!
//! Any member of the space sees the trash, as they saw the files. Restoring and erasing follow the
//! rule removing follows: the entry's owner, or an owner or administrator of the space. Entries past
//! the instance's retention are erased by an hourly sweep.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
    TransactionTrait,
};
use serde::Serialize;
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{file_versions, files};
use crate::state::AppState;

use super::authz;
use super::dto::{rfc3339, FileDto};
use super::error::FileError;

/// How often the sweep looks for entries past the retention.
const SWEEP_INTERVAL: Duration = Duration::from_secs(3600);

/// One entry of the trash.
#[derive(Debug, Serialize, ToSchema)]
pub struct TrashEntryDto {
    pub file: FileDto,
    pub deleted_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_by_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_by_name: Option<String>,
    /// The folder it was in (absent: the space root).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_folder_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_folder_name: Option<String>,
    /// Whether that folder is still there: restoring lands at the root otherwise.
    pub original_folder_present: bool,
    /// Whether the caller may restore it or erase it.
    pub can_manage: bool,
}

/// The answer to a restore.
#[derive(Debug, Serialize, ToSchema)]
pub struct RestoredDto {
    pub file: FileDto,
    /// Its folder was gone, so it came back at the space root.
    pub restored_to_root: bool,
}

/// The answer to emptying the trash.
#[derive(Debug, Serialize, ToSchema)]
pub struct EmptiedDto {
    /// How many trash entries were erased.
    pub erased: u64,
}

/// `GET /api/v1/spaces/{space_id}/trash`: what the space's trash holds, latest removal first.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/trash",
    tag = "files",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "The trash", body = [TrashEntryDto]),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn list_trash(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Json<Vec<TrashEntryDto>>, FileError> {
    authz::ensure_space_files_member(&state.db, space_id, session.user_id).await?;
    let admin = authz::is_space_admin(&state.db, space_id, session.user_id).await?;

    let roots = trash_roots(&state.db, space_id).await?;
    let parent_ids: Vec<Uuid> = roots.iter().filter_map(|f| f.parent_folder_id).collect();
    let parents: HashMap<Uuid, files::Model> = if parent_ids.is_empty() {
        HashMap::new()
    } else {
        files::Entity::find()
            .filter(files::Column::Id.is_in(parent_ids))
            .all(&state.db)
            .await?
            .into_iter()
            .map(|p| (p.id, p))
            .collect()
    };
    let removers: Vec<Uuid> = roots.iter().filter_map(|f| f.deleted_by).collect();
    let names = super::load_names(&state.db, removers).await?;

    let dtos = super::hydrate_files(&state.db, roots.clone()).await?;

    Ok(Json(
        dtos.into_iter()
            .zip(roots)
            .map(|(file, row)| {
                let parent = row.parent_folder_id;
                let folder = parent.and_then(|id| parents.get(&id));
                TrashEntryDto {
                    file,
                    deleted_at: row.deleted_at.map(rfc3339).unwrap_or_default(),
                    deleted_by_id: row.deleted_by,
                    deleted_by_name: row.deleted_by.and_then(|id| names.get(&id).cloned()),
                    original_folder_id: parent,
                    original_folder_name: folder.map(|f| f.name.clone()),
                    original_folder_present: match parent {
                        None => true,
                        Some(_) => folder.is_some_and(|f| f.deleted_at.is_none()),
                    },
                    can_manage: admin || row.owner_id == Some(session.user_id),
                }
            })
            .collect(),
    ))
}

/// `POST /api/v1/files/{file_id}/restore`: bring a trash entry back, with what was removed with it.
#[utoipa::path(
    post,
    path = "/api/v1/files/{file_id}/restore",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "Trash entry (file or folder) id")),
    responses(
        (status = 200, description = "Restored", body = RestoredDto),
        (status = 400, description = "Not in the trash"),
        (status = 403, description = "Not allowed to restore it"),
        (status = 404, description = "No such entry, or erased for good")
    )
)]
pub async fn restore_file(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
) -> Result<Json<RestoredDto>, FileError> {
    let root = managed_trash_entry(&state.db, file_id, session.user_id).await?;
    let batch = removal_batch(&state.db, &root).await?;

    // Back where it was, unless that folder is gone (removed, or erased): then at the root.
    let parent_present = match root.parent_folder_id {
        None => true,
        Some(parent) => files::Entity::find_by_id(parent)
            .one(&state.db)
            .await?
            .is_some_and(|p| p.deleted_at.is_none() && p.kind == "folder"),
    };

    let ids: Vec<Uuid> = batch.iter().map(|f| f.id).collect();
    let txn = state.db.begin().await?;
    files::Entity::update_many()
        .col_expr(
            files::Column::DeletedAt,
            Expr::value(Option::<OffsetDateTime>::None),
        )
        .col_expr(files::Column::DeletedBy, Expr::value(Option::<Uuid>::None))
        .col_expr(files::Column::Trashed, Expr::value(false))
        .filter(files::Column::Id.is_in(ids))
        .exec(&txn)
        .await?;
    if !parent_present {
        files::Entity::update_many()
            .col_expr(
                files::Column::ParentFolderId,
                Expr::value(Option::<Uuid>::None),
            )
            .filter(files::Column::Id.eq(root.id))
            .exec(&txn)
            .await?;
    }
    txn.commit().await?;

    let row = files::Entity::find_by_id(root.id)
        .one(&state.db)
        .await?
        .ok_or(FileError::Internal)?;
    let dto = super::hydrate_files(&state.db, vec![row.clone()])
        .await?
        .pop()
        .ok_or(FileError::Internal)?;
    super::versions::publish_updated(&state, &row, session.user_id, &dto).await;
    Ok(Json(RestoredDto {
        file: dto,
        restored_to_root: !parent_present,
    }))
}

/// `DELETE /api/v1/files/{file_id}/trash`: erase a trash entry for good.
#[utoipa::path(
    delete,
    path = "/api/v1/files/{file_id}/trash",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "Trash entry (file or folder) id")),
    responses(
        (status = 204, description = "Erased"),
        (status = 400, description = "Not in the trash"),
        (status = 403, description = "Not allowed to erase it"),
        (status = 404, description = "No such entry, or already erased")
    )
)]
pub async fn erase_file(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
) -> Result<StatusCode, FileError> {
    let root = managed_trash_entry(&state.db, file_id, session.user_id).await?;
    let batch = removal_batch(&state.db, &root).await?;
    erase(&state, batch).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/v1/spaces/{space_id}/trash`: erase every trash entry the caller may manage.
#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}/trash",
    tag = "files",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "Emptied", body = EmptiedDto),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn empty_trash(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Json<EmptiedDto>, FileError> {
    authz::ensure_space_files_member(&state.db, space_id, session.user_id).await?;
    let admin = authz::is_space_admin(&state.db, space_id, session.user_id).await?;
    let mut erased = 0;
    for root in trash_roots(&state.db, space_id).await? {
        if !admin && root.owner_id != Some(session.user_id) {
            continue;
        }
        let batch = removal_batch(&state.db, &root).await?;
        erase(&state, batch).await?;
        erased += 1;
    }
    Ok(Json(EmptiedDto { erased }))
}

/// Start the hourly sweep that erases what has been in the trash past the retention.
pub fn spawn(state: AppState) {
    if state.config.trash_retention_days == 0 {
        tracing::info!(
            "RUCHOIR_TRASH_RETENTION_DAYS is 0: the trash keeps its entries until emptied"
        );
        return;
    }
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            match sweep_once(&state, OffsetDateTime::now_utc()).await {
                Ok(0) => {}
                Ok(erased) => tracing::info!(erased, "erased trash entries past their retention"),
                Err(error) => tracing::warn!(?error, "trash sweep failed"),
            }
        }
    });
}

/// Erase the trash entries removed more than the retention ago. Returns how many.
pub(crate) async fn sweep_once(state: &AppState, now: OffsetDateTime) -> Result<u64, FileError> {
    let days = state.config.trash_retention_days;
    if days == 0 {
        return Ok(0);
    }
    let cutoff = now - time::Duration::days(i64::from(days));
    let expired = files::Entity::find()
        .filter(files::Column::Trashed.eq(true))
        .filter(files::Column::PurgedAt.is_null())
        .filter(files::Column::DeletedAt.lt(cutoff))
        .all(&state.db)
        .await?;
    let mut erased = 0;
    for root in expired {
        let batch = removal_batch(&state.db, &root).await?;
        erase(state, batch).await?;
        erased += 1;
    }
    Ok(erased)
}

/// The space's trash entries, latest removal first (a private conversation's files are not the
/// space's, and stay out of it).
async fn trash_roots(
    db: &DatabaseConnection,
    space_id: Uuid,
) -> Result<Vec<files::Model>, FileError> {
    Ok(files::Entity::find()
        .filter(files::Column::SpaceId.eq(space_id))
        .filter(files::Column::Trashed.eq(true))
        .filter(files::Column::PurgedAt.is_null())
        .filter(files::Column::ConversationId.is_null())
        .order_by_desc(files::Column::DeletedAt)
        .all(db)
        .await?)
}

/// A trash entry the caller may restore or erase, or the reason they may not.
async fn managed_trash_entry(
    db: &DatabaseConnection,
    file_id: Uuid,
    user_id: Uuid,
) -> Result<files::Model, FileError> {
    let file = files::Entity::find_by_id(file_id)
        .one(db)
        .await?
        .ok_or(FileError::NotFound)?;
    authz::ensure_space_files_member(db, file.space_id, user_id).await?;
    if file.purged_at.is_some() {
        return Err(FileError::NotFound);
    }
    if !file.trashed || file.deleted_at.is_none() {
        return Err(FileError::BadRequest("not in the trash"));
    }
    let manage =
        file.owner_id == Some(user_id) || authz::is_space_admin(db, file.space_id, user_id).await?;
    if !manage {
        return Err(FileError::Forbidden);
    }
    Ok(file)
}

/// A trash entry and everything removed with it: the entries under it removed at the same moment.
/// What was under it but removed before (its own trash entry) stays out.
async fn removal_batch(
    db: &DatabaseConnection,
    root: &files::Model,
) -> Result<Vec<files::Model>, FileError> {
    let mut batch = vec![root.clone()];
    if root.kind != "folder" {
        return Ok(batch);
    }
    let mut queue = vec![root.id];
    while let Some(parent) = queue.pop() {
        let children = files::Entity::find()
            .filter(files::Column::ParentFolderId.eq(parent))
            .filter(files::Column::DeletedAt.eq(root.deleted_at))
            .filter(files::Column::Trashed.eq(false))
            .filter(files::Column::PurgedAt.is_null())
            .all(db)
            .await?;
        for child in children {
            if child.kind == "folder" {
                queue.push(child.id);
            }
            batch.push(child);
        }
    }
    Ok(batch)
}

/// Erase entries for good: mark them purged, then delete the objects no living version still uses
/// (a restored version shares its object with the one it copies, and an import stores identical
/// bytes once).
async fn erase(state: &AppState, rows: Vec<files::Model>) -> Result<(), FileError> {
    if rows.is_empty() {
        return Ok(());
    }
    let ids: Vec<Uuid> = rows.iter().map(|f| f.id).collect();
    let versions = file_versions::Entity::find()
        .filter(file_versions::Column::FileId.is_in(ids.clone()))
        .all(&state.db)
        .await?;
    let keys: HashSet<String> = versions
        .iter()
        .flat_map(|v| [v.storage_key.clone(), v.thumbnail_key.clone()])
        .flatten()
        .collect();

    let now = OffsetDateTime::now_utc();
    files::Entity::update_many()
        .col_expr(files::Column::PurgedAt, Expr::value(now))
        .col_expr(files::Column::Trashed, Expr::value(false))
        .filter(files::Column::Id.is_in(ids))
        .exec(&state.db)
        .await?;

    let Some(storage) = state.storage.as_ref() else {
        return Ok(());
    };
    for key in keys {
        if still_used(&state.db, &key).await? {
            continue;
        }
        if let Err(error) = storage.delete(&key).await {
            // The row is a tombstone either way; an object left behind costs space, not correctness.
            tracing::warn!(%error, key, "could not erase an object from the store");
        }
    }
    Ok(())
}

/// Whether a version of a file not erased still stores its bytes (or thumbnail) under `key`.
async fn still_used(db: &DatabaseConnection, key: &str) -> Result<bool, FileError> {
    let users = file_versions::Entity::find()
        .filter(
            Condition::any()
                .add(file_versions::Column::StorageKey.eq(key))
                .add(file_versions::Column::ThumbnailKey.eq(key)),
        )
        .all(db)
        .await?;
    if users.is_empty() {
        return Ok(false);
    }
    let file_ids: Vec<Uuid> = users.iter().map(|v| v.file_id).collect();
    Ok(files::Entity::find()
        .filter(files::Column::Id.is_in(file_ids))
        .filter(files::Column::PurgedAt.is_null())
        .one(db)
        .await?
        .is_some())
}
