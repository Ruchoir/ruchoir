//! Saved-message endpoints: the per-user "Saved" bookmark list.
//!
//! Saving is private to the caller: nothing is shown to other users, and the `message.saved` /
//! `message.unsaved` events go only to the caller's own connections so the bookmark toggles stay in
//! sync across their devices. Saving requires access to the message's conversation at save time; the
//! list read re-checks access per conversation, so a bookmark to something later made private simply
//! stops appearing.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{messages, user_saved_messages};
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

use super::authz;
use super::conversations;
use super::dto::SavedMessageDto;
use super::error::ApiError;
use super::messages::{hydrate_messages, load_message};

/// The payload carried by a `message.saved` / `message.unsaved` event.
#[derive(Debug, Serialize)]
struct SaveEvent {
    message_id: Uuid,
    conversation_id: Uuid,
}

/// `GET /api/v1/me/saved`: the caller's saved messages, most recently saved first.
#[utoipa::path(
    get,
    path = "/api/v1/me/saved",
    tag = "messaging",
    responses((status = 200, description = "Saved messages", body = [SavedMessageDto]))
)]
pub async fn list_saved(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<Json<Vec<SavedMessageDto>>, ApiError> {
    let saved = user_saved_messages::Entity::find()
        .filter(user_saved_messages::Column::UserId.eq(session.user_id))
        .order_by_desc(user_saved_messages::Column::SavedAt)
        .all(&state.db)
        .await?;

    // Re-check access per conversation (cached), so bookmarks to now-inaccessible messages drop out.
    let mut access_cache: HashMap<Uuid, bool> = HashMap::new();
    let mut rows: Vec<messages::Model> = Vec::new();
    for entry in saved {
        let Some(message) = messages::Entity::find_by_id(entry.message_id)
            .one(&state.db)
            .await?
        else {
            continue;
        };
        let allowed = match access_cache.get(&message.conversation_id) {
            Some(allowed) => *allowed,
            None => {
                let allowed = authz::ensure_conversation_access(
                    &state.db,
                    message.conversation_id,
                    session.user_id,
                )
                .await
                .is_ok();
                access_cache.insert(message.conversation_id, allowed);
                allowed
            }
        };
        if allowed {
            rows.push(message);
        }
    }

    let conversation_ids: Vec<Uuid> = rows.iter().map(|m| m.conversation_id).collect();
    let labels = conversations::label_conversations(&state.db, conversation_ids).await?;
    let hydrated = hydrate_messages(&state.db, session.user_id, rows).await?;

    Ok(Json(
        hydrated
            .into_iter()
            .map(|message| {
                let label = labels.get(&message.conversation_id);
                SavedMessageDto {
                    space_id: label.map(|l| l.space_id).unwrap_or_default(),
                    space_name: label.map(|l| l.space_name.clone()).unwrap_or_default(),
                    channel_name: label.and_then(|l| l.channel_name.clone()),
                    message,
                }
            })
            .collect(),
    ))
}

/// `PUT /api/v1/messages/{message_id}/save`: bookmark a message.
#[utoipa::path(
    put,
    path = "/api/v1/messages/{message_id}/save",
    tag = "messaging",
    params(("message_id" = Uuid, Path, description = "Message id")),
    responses(
        (status = 204, description = "Message saved"),
        (status = 403, description = "No access to the conversation"),
        (status = 404, description = "Message not found")
    )
)]
pub async fn save_message(
    State(state): State<AppState>,
    session: AuthSession,
    Path(message_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let message = load_message(&state.db, message_id).await?;
    authz::ensure_conversation_access(&state.db, message.conversation_id, session.user_id).await?;

    let already = user_saved_messages::Entity::find_by_id((session.user_id, message_id))
        .one(&state.db)
        .await?
        .is_some();
    if !already {
        user_saved_messages::ActiveModel {
            user_id: Set(session.user_id),
            message_id: Set(message_id),
            saved_at: Set(OffsetDateTime::now_utc()),
        }
        .insert(&state.db)
        .await?;

        state
            .hub
            .publish(
                vec![session.user_id],
                RealtimeEnvelope::message_saved(
                    message.conversation_id,
                    SaveEvent {
                        message_id,
                        conversation_id: message.conversation_id,
                    },
                ),
            )
            .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/v1/messages/{message_id}/save`: remove a bookmark.
#[utoipa::path(
    delete,
    path = "/api/v1/messages/{message_id}/save",
    tag = "messaging",
    params(("message_id" = Uuid, Path, description = "Message id")),
    responses((status = 204, description = "Bookmark removed"))
)]
pub async fn unsave_message(
    State(state): State<AppState>,
    session: AuthSession,
    Path(message_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let result = user_saved_messages::Entity::delete_by_id((session.user_id, message_id))
        .exec(&state.db)
        .await?;
    if result.rows_affected > 0 {
        // The conversation is only needed for the event scope; look it up best-effort.
        if let Some(message) = messages::Entity::find_by_id(message_id)
            .one(&state.db)
            .await?
        {
            state
                .hub
                .publish(
                    vec![session.user_id],
                    RealtimeEnvelope::message_unsaved(
                        message.conversation_id,
                        SaveEvent {
                            message_id,
                            conversation_id: message.conversation_id,
                        },
                    ),
                )
                .await;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}
