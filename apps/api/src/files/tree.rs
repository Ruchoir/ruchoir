//! Folder-tree endpoints: list a folder, create a folder, rename/move, and soft-delete.
//!
//! Reads require space membership; mutations require the owner or a space owner/admin (the
//! [`super::authz`] choke point). Deletes are soft (a tombstone stays, so a message attachment can
//! still render), and deleting a folder soft-deletes its whole subtree. Object bytes are kept on
//! soft-delete because an attachment may still reference them.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::sea_query::Expr;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, IntoActiveModel, QueryFilter,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{files, message_attachments, messages};
use crate::messaging::authz as messaging_authz;
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

use super::authz;
use super::dto::{Breadcrumb, CreateFolderRequest, FileDto, FolderListing, UpdateFileRequest};
use super::error::FileError;

/// Guards against a pathological or corrupted parent chain when walking folders.
const MAX_TREE_DEPTH: usize = 64;

/// `GET /api/v1/conversations/{conversation_id}/files`: the files shared in one conversation.
///
/// The channel's file panel listed the whole space tree instead, under a title that promised the
/// channel's own: everything anyone had ever uploaded anywhere in the space, in a panel opened to
/// answer "what was shared here". A file belongs to this list because a message in this
/// conversation carries it, which is the only sense in which a conversation has files at all.
///
/// Newest first, deduplicated: the same file attached twice is one entry, dated by its latest use.
#[utoipa::path(
    get,
    path = "/api/v1/conversations/{conversation_id}/files",
    tag = "files",
    params(("conversation_id" = Uuid, Path, description = "Conversation id")),
    responses(
        (status = 200, description = "Files attached to this conversation's messages", body = [FileDto]),
        (status = 403, description = "No access to this conversation")
    )
)]
pub async fn list_conversation_files(
    State(state): State<AppState>,
    session: AuthSession,
    Path(conversation_id): Path<Uuid>,
) -> Result<Json<Vec<FileDto>>, FileError> {
    authz::conversation_access(&state.db, conversation_id, session.user_id).await?;

    // Message ids first, then their attachments: two indexed lookups rather than a join the ORM
    // would have to be taught, and the same shape the message hydrate already uses.
    let message_ids: Vec<Uuid> = messages::Entity::find()
        .filter(messages::Column::ConversationId.eq(conversation_id))
        .filter(messages::Column::DeletedAt.is_null())
        .all(&state.db)
        .await?
        .into_iter()
        .map(|m| m.id)
        .collect();
    if message_ids.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let links = message_attachments::Entity::find()
        .filter(message_attachments::Column::MessageId.is_in(message_ids))
        .all(&state.db)
        .await?;
    if links.is_empty() {
        return Ok(Json(Vec::new()));
    }

    // Deduplicated, because a file attached to several messages is still one file.
    let mut file_ids: Vec<Uuid> = links.into_iter().map(|l| l.file_id).collect();
    file_ids.sort();
    file_ids.dedup();

    let rows = files::Entity::find()
        .filter(files::Column::Id.is_in(file_ids))
        // A deleted file keeps its tombstone so the message still renders, but it has nothing left
        // to list here.
        .filter(files::Column::DeletedAt.is_null())
        .all(&state.db)
        .await?;

    let mut out = super::hydrate_files(&state.db, rows).await?;
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(Json(out))
}

/// Query string for a folder listing: the folder to open (absent = the space root).
#[derive(Debug, Deserialize)]
pub struct FolderQuery {
    #[serde(default)]
    pub folder: Option<Uuid>,
}

/// `GET /api/v1/spaces/{space_id}/files`: the contents of a folder (or the space root).
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/files",
    tag = "files",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("folder" = Option<Uuid>, Query, description = "Folder to open (root when omitted)")
    ),
    responses(
        (status = 200, description = "Folder contents", body = FolderListing),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn list_folder(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Query(query): Query<FolderQuery>,
) -> Result<Json<FolderListing>, FileError> {
    authz::ensure_space_files_member(&state.db, space_id, session.user_id).await?;

    let mut breadcrumb = Vec::new();
    if let Some(folder_id) = query.folder {
        let folder = files::Entity::find_by_id(folder_id)
            .one(&state.db)
            .await?
            .ok_or(FileError::NotFound)?;
        if folder.space_id != space_id || folder.kind != "folder" || folder.deleted_at.is_some() {
            return Err(FileError::BadRequest("invalid folder"));
        }
        breadcrumb = build_breadcrumb(&state.db, &folder).await?;
    }

    let mut select = files::Entity::find()
        .filter(files::Column::SpaceId.eq(space_id))
        .filter(files::Column::DeletedAt.is_null())
        // A file attached to a private conversation is not part of the space's tree: it is reachable
        // from its message and nowhere else. Listing it here would leak its existence and its name to
        // every member of the space, which is exactly what its `conversation_id` prevents.
        .filter(files::Column::ConversationId.is_null());
    select = match query.folder {
        Some(folder_id) => select.filter(files::Column::ParentFolderId.eq(folder_id)),
        None => select.filter(files::Column::ParentFolderId.is_null()),
    };
    let mut rows = select.all(&state.db).await?;

    // Folders first, then case-insensitive by name.
    rows.sort_by(|a, b| {
        let a_is_file = a.kind != "folder";
        let b_is_file = b.kind != "folder";
        a_is_file
            .cmp(&b_is_file)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let entries = super::hydrate_files(&state.db, rows).await?;
    Ok(Json(FolderListing {
        folder_id: query.folder,
        breadcrumb,
        entries,
    }))
}

/// `POST /api/v1/spaces/{space_id}/folders`: create a folder.
#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/folders",
    tag = "files",
    params(("space_id" = Uuid, Path, description = "Space id")),
    request_body = CreateFolderRequest,
    responses(
        (status = 201, description = "Folder created", body = FileDto),
        (status = 400, description = "Missing name or invalid parent"),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn create_folder(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Json(body): Json<CreateFolderRequest>,
) -> Result<(StatusCode, Json<FileDto>), FileError> {
    authz::ensure_space_files_member(&state.db, space_id, session.user_id).await?;

    let name = clean_name(&body.name);
    if name.is_empty() {
        return Err(FileError::BadRequest("folder name is required"));
    }
    if let Some(parent_id) = body.parent_folder_id {
        ensure_folder_in_space(&state.db, parent_id, space_id).await?;
    }

    let folder_id = Uuid::new_v4();
    let now = OffsetDateTime::now_utc();
    files::ActiveModel {
        id: Set(folder_id),
        space_id: Set(space_id),
        owner_id: Set(Some(session.user_id)),
        name: Set(name),
        kind: Set("folder".to_owned()),
        parent_folder_id: Set(body.parent_folder_id),
        size_bytes: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(&state.db)
    .await?;

    let dto = single_dto(&state.db, folder_id).await?;
    Ok((StatusCode::CREATED, Json(dto)))
}

/// `PATCH /api/v1/files/{file_id}`: rename and/or move a file or folder.
#[utoipa::path(
    patch,
    path = "/api/v1/files/{file_id}",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File or folder id")),
    request_body = UpdateFileRequest,
    responses(
        (status = 200, description = "Updated entry", body = FileDto),
        (status = 400, description = "Invalid name or move target"),
        (status = 403, description = "Not allowed to modify this file")
    )
)]
pub async fn update_file(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
    Json(body): Json<UpdateFileRequest>,
) -> Result<Json<FileDto>, FileError> {
    let access = authz::ensure_editable(&state.db, file_id, session.user_id).await?;
    let file = access.file;

    let mut active = file.clone().into_active_model();
    let mut changed = false;

    if let Some(new_name) = body.name {
        let name = clean_name(&new_name);
        if name.is_empty() {
            return Err(FileError::BadRequest("name is required"));
        }
        active.name = Set(name);
        changed = true;
    }

    if body.move_to_root {
        active.parent_folder_id = Set(None);
        changed = true;
    } else if let Some(target_id) = body.parent_folder_id {
        ensure_folder_in_space(&state.db, target_id, file.space_id).await?;
        if target_id == file.id {
            return Err(FileError::BadRequest("cannot move a folder into itself"));
        }
        if is_descendant(&state.db, target_id, file.id).await? {
            return Err(FileError::BadRequest(
                "cannot move a folder into its own subtree",
            ));
        }
        active.parent_folder_id = Set(Some(target_id));
        changed = true;
    }

    if changed {
        active.updated_at = Set(OffsetDateTime::now_utc());
        active.update(&state.db).await?;
    }

    let dto = single_dto(&state.db, file_id).await?;
    Ok(Json(dto))
}

/// `DELETE /api/v1/files/{file_id}`: soft-delete a file, or a folder and its whole subtree.
#[utoipa::path(
    delete,
    path = "/api/v1/files/{file_id}",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File or folder id")),
    responses(
        (status = 204, description = "Deleted"),
        (status = 403, description = "Not allowed to delete this file")
    )
)]
pub async fn delete_file(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
) -> Result<StatusCode, FileError> {
    let access = authz::ensure_editable(&state.db, file_id, session.user_id).await?;
    let file = access.file;
    let now = OffsetDateTime::now_utc();

    let txn = state.db.begin().await?;

    // Collect the id and, for a folder, its descendant ids (breadth-first over the subtree).
    let mut to_delete = vec![file.id];
    if file.kind == "folder" {
        let mut queue = vec![file.id];
        while let Some(parent) = queue.pop() {
            let children = files::Entity::find()
                .filter(files::Column::ParentFolderId.eq(parent))
                .filter(files::Column::DeletedAt.is_null())
                .all(&txn)
                .await?;
            for child in children {
                to_delete.push(child.id);
                if child.kind == "folder" {
                    queue.push(child.id);
                }
            }
        }
    }

    files::Entity::update_many()
        .col_expr(files::Column::DeletedAt, Expr::value(now))
        .col_expr(files::Column::UpdatedAt, Expr::value(now))
        .filter(files::Column::Id.is_in(to_delete.clone()))
        .exec(&txn)
        .await?;
    txn.commit().await?;

    // Told to the space, not only to the caller. A deleted file may be attached to a message
    // someone else is looking at right now, where it would go on offering bytes that no longer
    // exist until that page happened to be reloaded.
    let audience = messaging_authz::space_member_ids(&state.db, file.space_id, session.user_id)
        .await
        .unwrap_or_default();
    if !audience.is_empty() {
        state
            .hub
            .publish(
                audience,
                RealtimeEnvelope::files_deleted(FilesDeletedEvent {
                    space_id: file.space_id,
                    file_ids: to_delete,
                }),
            )
            .await;
    }

    Ok(StatusCode::NO_CONTENT)
}

/// The payload carried by a `files.deleted` event: a folder takes its subtree with it, so this is
/// a list rather than one id.
#[derive(Debug, Serialize)]
struct FilesDeletedEvent {
    space_id: Uuid,
    file_ids: Vec<Uuid>,
}

/// Clean a user-supplied name: strip any path component, drop control characters, trim, and cap the
/// length. Returns an empty string when nothing usable remains (callers apply their own default).
pub(super) fn clean_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let cleaned: String = base.chars().filter(|c| !c.is_control()).collect();
    cleaned.trim().chars().take(255).collect()
}

/// Load a single file as a DTO, or fail with an internal error if it vanished mid-request.
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

/// Validate that `folder_id` is a live folder in `space_id`, else a `400`.
async fn ensure_folder_in_space(
    db: &DatabaseConnection,
    folder_id: Uuid,
    space_id: Uuid,
) -> Result<(), FileError> {
    let folder = files::Entity::find_by_id(folder_id)
        .one(db)
        .await?
        .ok_or(FileError::BadRequest("target folder not found"))?;
    if folder.space_id != space_id || folder.kind != "folder" || folder.deleted_at.is_some() {
        return Err(FileError::BadRequest("invalid target folder"));
    }
    Ok(())
}

/// Whether `start` is at or below `ancestor` in the folder tree (walking parents upward).
async fn is_descendant(
    db: &DatabaseConnection,
    start: Uuid,
    ancestor: Uuid,
) -> Result<bool, FileError> {
    let mut current = Some(start);
    let mut depth = 0;
    while let Some(id) = current {
        if id == ancestor {
            return Ok(true);
        }
        depth += 1;
        if depth > MAX_TREE_DEPTH {
            break;
        }
        current = files::Entity::find_by_id(id)
            .one(db)
            .await?
            .and_then(|f| f.parent_folder_id);
    }
    Ok(false)
}

/// Build the breadcrumb from the space root down to `folder`.
async fn build_breadcrumb(
    db: &DatabaseConnection,
    folder: &files::Model,
) -> Result<Vec<Breadcrumb>, FileError> {
    let mut chain = vec![Breadcrumb {
        id: folder.id,
        name: folder.name.clone(),
    }];
    let mut parent = folder.parent_folder_id;
    let mut depth = 0;
    while let Some(parent_id) = parent {
        depth += 1;
        if depth > MAX_TREE_DEPTH {
            break;
        }
        match files::Entity::find_by_id(parent_id).one(db).await? {
            Some(row) => {
                chain.push(Breadcrumb {
                    id: row.id,
                    name: row.name.clone(),
                });
                parent = row.parent_folder_id;
            }
            None => break,
        }
    }
    chain.reverse();
    Ok(chain)
}
