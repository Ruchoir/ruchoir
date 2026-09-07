//! Full-text search over messages and file names, scoped to what the caller can see.
//!
//! Native PostgreSQL, no external service. Messages match either the generated `tsvector` (word and
//! stem search, accent-insensitive) or an accent-folded trigram substring (`pg_trgm`), ranked by
//! `ts_rank` then recency. File names match on the accent-folded trigram index. Authorization reuses
//! the messaging `authz` guard: results are restricted to the caller's accessible conversations, and
//! file search to space membership.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::Json;
use sea_orm::{ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, QueryFilter, Statement};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::messages;
use crate::state::AppState;

use super::authz;
use super::dto::{FileHitDto, SearchResults};
use super::error::ApiError;
use super::messages::hydrate_messages;

const DEFAULT_LIMIT: u64 = 30;
const MAX_LIMIT: u64 = 50;

/// Search request. `type` is `messages`, `files` or `all` (default). `conversation_id` narrows a
/// message search to a single conversation (the per-channel search panel).
#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
    pub space_id: Uuid,
    pub conversation_id: Option<Uuid>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub limit: Option<u64>,
    /// Skip this many results (offset pagination for "load more"). Defaults to 0.
    pub offset: Option<u64>,
}

/// `GET /api/v1/search`: messages and file names matching `q` that the caller can see.
#[utoipa::path(
    get,
    path = "/api/v1/search",
    tag = "messaging",
    params(
        ("q" = String, Query, description = "Search text"),
        ("space_id" = Uuid, Query, description = "Space to search within"),
        ("conversation_id" = Option<Uuid>, Query, description = "Restrict messages to one conversation"),
        ("type" = Option<String>, Query, description = "messages | files | all (default)"),
        ("limit" = Option<u64>, Query, description = "Max results per kind (max 50)"),
        ("offset" = Option<u64>, Query, description = "Skip this many results (load more)")
    ),
    responses(
        (status = 200, description = "Search results", body = SearchResults),
        (status = 403, description = "Not a member of the space or conversation")
    )
)]
pub async fn search(
    State(state): State<AppState>,
    session: AuthSession,
    Query(query): Query<SearchQuery>,
) -> Result<Json<SearchResults>, ApiError> {
    let needle = query.q.trim().to_owned();
    if needle.is_empty() {
        return Ok(Json(SearchResults {
            messages: Vec::new(),
            files: Vec::new(),
        }));
    }
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    let offset = query.offset.unwrap_or(0);
    let kind = query.kind.as_deref().unwrap_or("all");
    let want_messages = kind != "files";
    // Files are space-scoped, not per-conversation: a conversation-scoped search returns messages only.
    let want_files = kind != "messages" && query.conversation_id.is_none();

    // Resolve the conversation ids in scope, enforcing membership along the way.
    let conversation_ids = if let Some(conversation_id) = query.conversation_id {
        let access =
            authz::ensure_conversation_access(&state.db, conversation_id, session.user_id).await?;
        if access.space_id != query.space_id {
            return Err(ApiError::Forbidden);
        }
        vec![conversation_id]
    } else {
        authz::accessible_conversation_ids(&state.db, query.space_id, session.user_id).await?
    };

    let messages = if want_messages && !conversation_ids.is_empty() {
        search_messages(
            &state.db,
            session.user_id,
            &needle,
            &conversation_ids,
            limit,
            offset,
        )
        .await?
    } else {
        Vec::new()
    };

    let files = if want_files {
        search_files(&state.db, query.space_id, &needle, limit, offset).await?
    } else {
        Vec::new()
    };

    Ok(Json(SearchResults { messages, files }))
}

/// Rank matching message ids, then load and hydrate them in rank order.
async fn search_messages(
    db: &sea_orm::DatabaseConnection,
    caller: Uuid,
    needle: &str,
    conversation_ids: &[Uuid],
    limit: u64,
    offset: u64,
) -> Result<Vec<super::dto::MessageDto>, ApiError> {
    // Conversation ids come from the database (authz), never the client, so inlining them is safe.
    let id_list = conversation_ids
        .iter()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id FROM messages \
         WHERE deleted_at IS NULL \
           AND conversation_id IN ({id_list}) \
           AND (search_vector @@ websearch_to_tsquery('fr_unaccent', $1) \
                OR ruchoir_unaccent(body) ILIKE '%' || ruchoir_unaccent($1) || '%') \
         ORDER BY ts_rank(search_vector, websearch_to_tsquery('fr_unaccent', $1)) DESC, \
                  created_at DESC, id DESC \
         LIMIT $2 OFFSET $3"
    );
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            &sql,
            [needle.into(), (limit as i64).into(), (offset as i64).into()],
        ))
        .await?;
    let ranked: Vec<Uuid> = rows
        .iter()
        .map(|row| row.try_get::<Uuid>("", "id"))
        .collect::<Result<_, _>>()?;
    if ranked.is_empty() {
        return Ok(Vec::new());
    }

    let mut found: HashMap<Uuid, messages::Model> = messages::Entity::find()
        .filter(messages::Column::Id.is_in(ranked.clone()))
        .all(db)
        .await?
        .into_iter()
        .map(|m| (m.id, m))
        .collect();
    let ordered: Vec<messages::Model> = ranked.iter().filter_map(|id| found.remove(id)).collect();

    hydrate_messages(db, caller, ordered).await
}

/// Match file names by accent-folded trigram substring.
async fn search_files(
    db: &sea_orm::DatabaseConnection,
    space_id: Uuid,
    needle: &str,
    limit: u64,
    offset: u64,
) -> Result<Vec<FileHitDto>, ApiError> {
    // `conversation_id IS NULL` for the same reason the space tree excludes them: a file attached to
    // a private conversation is readable only by its participants, so its name must not surface in a
    // space-wide search either.
    let sql = "SELECT id, name, kind FROM files \
               WHERE space_id = $1 AND deleted_at IS NULL AND conversation_id IS NULL \
                 AND ruchoir_unaccent(name) ILIKE '%' || ruchoir_unaccent($2) || '%' \
               ORDER BY name ASC \
               LIMIT $3 OFFSET $4";
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            [
                space_id.into(),
                needle.into(),
                (limit as i64).into(),
                (offset as i64).into(),
            ],
        ))
        .await?;
    rows.iter()
        .map(|row| {
            Ok(FileHitDto {
                id: row.try_get::<Uuid>("", "id")?,
                name: row.try_get::<String>("", "name")?,
                kind: row.try_get::<String>("", "kind")?,
            })
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()
        .map_err(ApiError::from)
}
