//! Reaction endpoints: add or remove one emoji reaction on a message.
//!
//! Both directions are idempotent: adding a reaction the caller already has, or removing one they
//! never had, succeeds without error and without a duplicate event. The emoji is a path segment
//! (native Unicode, URL-encoded by the client). Reaction counts are derived at read time in
//! [`super::messages::hydrate_messages`]; the fan-out payload only names the delta so clients can
//! update their view without a refetch.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter};
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::message_reactions;
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

use super::authz;
use super::error::ApiError;
use super::messages::load_message;

/// The delta carried by a `reaction.added` / `reaction.removed` event.
#[derive(Debug, Serialize)]
struct ReactionEvent {
    message_id: Uuid,
    conversation_id: Uuid,
    emoji: String,
    user_id: Uuid,
}

/// Reject an implausible emoji token early (empty, or longer than any real grapheme cluster).
fn validate_emoji(raw: &str) -> Result<String, ApiError> {
    let emoji = raw.trim();
    if emoji.is_empty() || emoji.chars().count() > 16 || emoji.contains(char::is_control) {
        return Err(ApiError::BadRequest("invalid emoji"));
    }
    Ok(emoji.to_owned())
}

/// `PUT /api/v1/messages/{message_id}/reactions/{emoji}`: add the caller's reaction.
#[utoipa::path(
    put,
    path = "/api/v1/messages/{message_id}/reactions/{emoji}",
    tag = "messaging",
    params(
        ("message_id" = Uuid, Path, description = "Message id"),
        ("emoji" = String, Path, description = "Native Unicode emoji")
    ),
    responses(
        (status = 204, description = "Reaction present"),
        (status = 403, description = "No access to the conversation"),
        (status = 404, description = "Message not found")
    )
)]
pub async fn add_reaction(
    State(state): State<AppState>,
    session: AuthSession,
    Path((message_id, emoji)): Path<(Uuid, String)>,
) -> Result<StatusCode, ApiError> {
    let emoji = validate_emoji(&emoji)?;
    let message = load_message(&state.db, message_id).await?;
    let access =
        authz::ensure_conversation_access(&state.db, message.conversation_id, session.user_id)
            .await?;
    // Reacting is taking part, like writing: for the channel's members only.
    if access.kind == authz::ConversationKind::Channel {
        super::channels::ensure_taking_part(&state, message.conversation_id, session.user_id)
            .await?;
    }

    let existing =
        message_reactions::Entity::find_by_id((message_id, session.user_id, emoji.clone()))
            .one(&state.db)
            .await?;
    if existing.is_none() {
        message_reactions::ActiveModel {
            message_id: Set(message_id),
            user_id: Set(session.user_id),
            emoji: Set(emoji.clone()),
            created_at: Set(OffsetDateTime::now_utc()),
        }
        .insert(&state.db)
        .await?;

        let audience = authz::conversation_audience(&state.db, &access).await?;
        state
            .hub
            .publish(
                audience,
                RealtimeEnvelope::reaction_added(
                    message.conversation_id,
                    ReactionEvent {
                        message_id,
                        conversation_id: message.conversation_id,
                        emoji,
                        user_id: session.user_id,
                    },
                ),
            )
            .await;
    }

    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/v1/messages/{message_id}/reactions/{emoji}`: remove the caller's reaction.
#[utoipa::path(
    delete,
    path = "/api/v1/messages/{message_id}/reactions/{emoji}",
    tag = "messaging",
    params(
        ("message_id" = Uuid, Path, description = "Message id"),
        ("emoji" = String, Path, description = "Native Unicode emoji")
    ),
    responses(
        (status = 204, description = "Reaction absent"),
        (status = 403, description = "No access to the conversation"),
        (status = 404, description = "Message not found")
    )
)]
pub async fn remove_reaction(
    State(state): State<AppState>,
    session: AuthSession,
    Path((message_id, emoji)): Path<(Uuid, String)>,
) -> Result<StatusCode, ApiError> {
    let emoji = validate_emoji(&emoji)?;
    let message = load_message(&state.db, message_id).await?;
    let access =
        authz::ensure_conversation_access(&state.db, message.conversation_id, session.user_id)
            .await?;
    if access.kind == authz::ConversationKind::Channel {
        super::channels::ensure_taking_part(&state, message.conversation_id, session.user_id)
            .await?;
    }

    let result = message_reactions::Entity::delete_many()
        .filter(message_reactions::Column::MessageId.eq(message_id))
        .filter(message_reactions::Column::UserId.eq(session.user_id))
        .filter(message_reactions::Column::Emoji.eq(emoji.clone()))
        .exec(&state.db)
        .await?;

    if result.rows_affected > 0 {
        let audience = authz::conversation_audience(&state.db, &access).await?;
        state
            .hub
            .publish(
                audience,
                RealtimeEnvelope::reaction_removed(
                    message.conversation_id,
                    ReactionEvent {
                        message_id,
                        conversation_id: message.conversation_id,
                        emoji,
                        user_id: session.user_id,
                    },
                ),
            )
            .await;
    }

    Ok(StatusCode::NO_CONTENT)
}
