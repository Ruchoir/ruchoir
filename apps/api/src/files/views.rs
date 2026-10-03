//! The drive's views beyond a folder: what changed lately, a person's favourites, what others sent
//! them in their conversations, and a search through the whole space. Each entry says where it
//! lives (its path), so a person can go to its folder.
//!
//! All of them read the space's tree as a member does (a guest has no space files), and leave out
//! what is in the trash. "Shared with me" is the one that reaches past the tree: a file sent in a
//! private conversation the person takes part in, which no folder holds.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DbBackend, EntityTrait, FromQueryResult,
    QueryFilter, QueryOrder, QuerySelect, Statement,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{channel_members, channels, dm_participants, file_stars, files};
use crate::state::AppState;

use super::authz;
use super::dto::{rfc3339, Breadcrumb, FileDto};
use super::error::FileError;

/// How many entries a view returns at most.
const VIEW_LIMIT: u64 = 100;

/// One entry of a view: the file, where it lives, and for "shared with me" who sent it where.
#[derive(Debug, Serialize, ToSchema)]
pub struct ViewEntryDto {
    pub file: FileDto,
    /// Its folders from the space root down (empty at the root, and for a private conversation's file).
    pub path: Vec<Breadcrumb>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_by_name: Option<String>,
    /// `channel` or `dm`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_in_kind: Option<String>,
    /// The channel's name (a direct message has none to give).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_in_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_at: Option<String>,
}

/// A search through the space's files.
#[derive(Debug, Deserialize, IntoParams)]
pub struct SearchQuery {
    /// Words the name contains (case and accents as typed; the database compares without case).
    pub q: String,
}

/// `GET /api/v1/spaces/{space_id}/files/recent`: the files changed most lately.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/files/recent",
    tag = "files",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "Latest changes first", body = [ViewEntryDto]),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn recent(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Json<Vec<ViewEntryDto>>, FileError> {
    authz::ensure_space_files_member(&state.db, space_id, session.user_id).await?;
    let rows = tree_files(space_id)
        .filter(files::Column::Kind.ne("folder"))
        .order_by_desc(files::Column::UpdatedAt)
        .limit(VIEW_LIMIT)
        .all(&state.db)
        .await?;
    Ok(Json(entries(&state.db, session.user_id, rows).await?))
}

/// `GET /api/v1/spaces/{space_id}/files/starred`: the caller's favourites, latest first.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/files/starred",
    tag = "files",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "The favourites", body = [ViewEntryDto]),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn starred(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Json<Vec<ViewEntryDto>>, FileError> {
    authz::ensure_space_files_member(&state.db, space_id, session.user_id).await?;
    let stars = file_stars::Entity::find()
        .filter(file_stars::Column::UserId.eq(session.user_id))
        .order_by_desc(file_stars::Column::CreatedAt)
        .all(&state.db)
        .await?;
    let order: Vec<Uuid> = stars.iter().map(|s| s.file_id).collect();
    if order.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let mut rows = tree_files(space_id)
        .filter(files::Column::Id.is_in(order.clone()))
        .all(&state.db)
        .await?;
    let rank: HashMap<Uuid, usize> = order.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    rows.sort_by_key(|f| rank.get(&f.id).copied().unwrap_or(usize::MAX));
    Ok(Json(entries(&state.db, session.user_id, rows).await?))
}

/// `GET /api/v1/spaces/{space_id}/files/search?q=`: files and folders of the whole space whose name
/// contains the words, folders first.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/files/search",
    tag = "files",
    params(("space_id" = Uuid, Path, description = "Space id"), SearchQuery),
    responses(
        (status = 200, description = "The matches", body = [ViewEntryDto]),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn search(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<ViewEntryDto>>, FileError> {
    authz::ensure_space_files_member(&state.db, space_id, session.user_id).await?;
    let words = query.q.trim();
    if words.is_empty() {
        return Ok(Json(Vec::new()));
    }
    // The words are the pattern's content, never its syntax: a `%` or a `_` typed is looked for.
    let escaped = words
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let mut rows = tree_files(space_id)
        .filter(sea_orm::sea_query::Expr::col(files::Column::Name).ilike(format!("%{escaped}%")))
        .order_by_desc(files::Column::UpdatedAt)
        .limit(VIEW_LIMIT)
        .all(&state.db)
        .await?;
    rows.sort_by_key(|f| f.kind != "folder");
    Ok(Json(entries(&state.db, session.user_id, rows).await?))
}

/// The latest time a file was sent by someone else into one of the caller's conversations.
#[derive(Debug, FromQueryResult)]
struct SharedRow {
    file_id: Uuid,
    author_id: Option<Uuid>,
    conversation_id: Uuid,
    created_at: OffsetDateTime,
}

/// `GET /api/v1/spaces/{space_id}/files/shared`: files others sent into the caller's conversations
/// of the space (the channels they joined, their direct messages), latest first.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/files/shared",
    tag = "files",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "Latest first", body = [ViewEntryDto]),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn shared_with_me(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Json<Vec<ViewEntryDto>>, FileError> {
    authz::ensure_space_member(&state.db, space_id, session.user_id).await?;
    let me = session.user_id;

    let joined: Vec<Uuid> = channel_members::Entity::find()
        .filter(channel_members::Column::UserId.eq(me))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|m| m.channel_id)
        .collect();
    let channel_rows = if joined.is_empty() {
        Vec::new()
    } else {
        channels::Entity::find()
            .filter(channels::Column::Id.is_in(joined))
            .filter(channels::Column::SpaceId.eq(space_id))
            .all(&state.db)
            .await?
    };
    let channel_names: HashMap<Uuid, String> =
        channel_rows.into_iter().map(|c| (c.id, c.name)).collect();
    let dms: HashSet<Uuid> = dm_participants::Entity::find()
        .filter(dm_participants::Column::UserId.eq(me))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|p| p.dm_id)
        .collect();
    let dms: HashSet<Uuid> = if dms.is_empty() {
        dms
    } else {
        crate::entities::dm_conversations::Entity::find()
            .filter(crate::entities::dm_conversations::Column::Id.is_in(dms))
            .filter(crate::entities::dm_conversations::Column::SpaceId.eq(space_id))
            .all(&state.db)
            .await?
            .into_iter()
            .map(|d| d.id)
            .collect()
    };
    let conversations: Vec<Uuid> = channel_names
        .keys()
        .copied()
        .chain(dms.iter().copied())
        .collect();
    if conversations.is_empty() {
        return Ok(Json(Vec::new()));
    }

    // One row per file: its latest sending by someone else. A join the ORM would need teaching,
    // written as the SQL it is.
    let mut shared = SharedRow::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT DISTINCT ON (ma.file_id) ma.file_id, m.author_id, m.conversation_id, m.created_at \
         FROM message_attachments ma JOIN messages m ON m.id = ma.message_id \
         WHERE m.conversation_id = ANY($1) AND m.deleted_at IS NULL \
           AND (m.author_id IS NULL OR m.author_id <> $2) \
         ORDER BY ma.file_id, m.created_at DESC",
        [conversations.into(), me.into()],
    ))
    .all(&state.db)
    .await?;
    shared.sort_by_key(|s| std::cmp::Reverse(s.created_at));
    shared.truncate(VIEW_LIMIT as usize);
    if shared.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let ids: Vec<Uuid> = shared.iter().map(|s| s.file_id).collect();
    let alive: HashMap<Uuid, files::Model> = files::Entity::find()
        .filter(files::Column::Id.is_in(ids))
        .filter(files::Column::DeletedAt.is_null())
        .filter(files::Column::PurgedAt.is_null())
        .all(&state.db)
        .await?
        .into_iter()
        .map(|f| (f.id, f))
        .collect();
    let rows: Vec<files::Model> = shared
        .iter()
        .filter_map(|s| alive.get(&s.file_id).cloned())
        .collect();
    let names = super::load_names(
        &state.db,
        shared.iter().filter_map(|s| s.author_id).collect(),
    )
    .await?;
    let by_file: HashMap<Uuid, &SharedRow> = shared.iter().map(|s| (s.file_id, s)).collect();

    let mut out = entries(&state.db, me, rows).await?;
    for entry in out.iter_mut() {
        if let Some(row) = by_file.get(&entry.file.id) {
            entry.shared_by_name = row.author_id.and_then(|id| names.get(&id).cloned());
            let channel = channel_names.get(&row.conversation_id);
            entry.shared_in_kind =
                Some(if channel.is_some() { "channel" } else { "dm" }.to_owned());
            entry.shared_in_name = channel.cloned();
            entry.shared_at = Some(rfc3339(row.created_at));
        }
    }
    Ok(Json(out))
}

/// `PUT /api/v1/files/{file_id}/star`: keep a file or folder among one's favourites.
#[utoipa::path(
    put,
    path = "/api/v1/files/{file_id}/star",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File or folder id")),
    responses((status = 204, description = "A favourite"), (status = 403, description = "No access to it"))
)]
pub async fn star(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
) -> Result<StatusCode, FileError> {
    authz::ensure_readable(&state.db, file_id, session.user_id).await?;
    let exists = file_stars::Entity::find_by_id((session.user_id, file_id))
        .one(&state.db)
        .await?
        .is_some();
    if !exists {
        file_stars::ActiveModel {
            user_id: Set(session.user_id),
            file_id: Set(file_id),
            created_at: Set(OffsetDateTime::now_utc()),
        }
        .insert(&state.db)
        .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/v1/files/{file_id}/star`: no longer a favourite.
#[utoipa::path(
    delete,
    path = "/api/v1/files/{file_id}/star",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File or folder id")),
    responses((status = 204, description = "No longer a favourite"))
)]
pub async fn unstar(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
) -> Result<StatusCode, FileError> {
    file_stars::Entity::delete_many()
        .filter(file_stars::Column::UserId.eq(session.user_id))
        .filter(file_stars::Column::FileId.eq(file_id))
        .exec(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Mark the entries `user_id` keeps among their favourites.
pub(crate) async fn mark_starred(
    db: &DatabaseConnection,
    user_id: Uuid,
    dtos: &mut [FileDto],
) -> Result<(), FileError> {
    if dtos.is_empty() {
        return Ok(());
    }
    let ids: Vec<Uuid> = dtos.iter().map(|d| d.id).collect();
    let stars: HashSet<Uuid> = file_stars::Entity::find()
        .filter(file_stars::Column::UserId.eq(user_id))
        .filter(file_stars::Column::FileId.is_in(ids))
        .all(db)
        .await?
        .into_iter()
        .map(|s| s.file_id)
        .collect();
    for dto in dtos.iter_mut() {
        dto.starred = stars.contains(&dto.id);
    }
    Ok(())
}

/// The space's tree as a member reads it: not in the trash, not a private conversation's.
fn tree_files(space_id: Uuid) -> sea_orm::Select<files::Entity> {
    files::Entity::find()
        .filter(files::Column::SpaceId.eq(space_id))
        .filter(files::Column::DeletedAt.is_null())
        .filter(files::Column::ConversationId.is_null())
}

/// Hydrate rows into entries with their paths and the caller's favourites.
async fn entries(
    db: &DatabaseConnection,
    user_id: Uuid,
    rows: Vec<files::Model>,
) -> Result<Vec<ViewEntryDto>, FileError> {
    let paths = paths_of(db, &rows).await?;
    let mut dtos = super::hydrate_files(db, rows).await?;
    mark_starred(db, user_id, &mut dtos).await?;
    Ok(dtos
        .into_iter()
        .map(|file| ViewEntryDto {
            path: paths.get(&file.id).cloned().unwrap_or_default(),
            file,
            shared_by_name: None,
            shared_in_kind: None,
            shared_in_name: None,
            shared_at: None,
        })
        .collect())
}

/// Each row's folders from the root down, walked a level at a time for all rows together (a
/// handful of queries, however many rows).
async fn paths_of(
    db: &DatabaseConnection,
    rows: &[files::Model],
) -> Result<HashMap<Uuid, Vec<Breadcrumb>>, FileError> {
    let mut folders: HashMap<Uuid, (String, Option<Uuid>)> = HashMap::new();
    let mut wanted: HashSet<Uuid> = rows.iter().filter_map(|f| f.parent_folder_id).collect();
    // A cycle cannot exist (moves refuse it), but a bound keeps a damaged tree from looping.
    for _ in 0..64 {
        wanted.retain(|id| !folders.contains_key(id));
        if wanted.is_empty() {
            break;
        }
        let found = files::Entity::find()
            .filter(files::Column::Id.is_in(wanted.iter().copied().collect::<Vec<_>>()))
            .all(db)
            .await?;
        wanted.clear();
        for f in found {
            if let Some(parent) = f.parent_folder_id {
                wanted.insert(parent);
            }
            folders.insert(f.id, (f.name, f.parent_folder_id));
        }
    }
    let mut out = HashMap::new();
    for row in rows {
        let mut path = Vec::new();
        let mut at = row.parent_folder_id;
        while let Some(id) = at {
            let Some((name, parent)) = folders.get(&id) else {
                break;
            };
            path.push(Breadcrumb {
                id,
                name: name.clone(),
            });
            at = *parent;
            if path.len() > 64 {
                break;
            }
        }
        path.reverse();
        out.insert(row.id, path);
    }
    Ok(out)
}
