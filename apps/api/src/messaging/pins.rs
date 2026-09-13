//! Pin endpoints: list, pin and unpin messages in a channel.
//!
//! A channel's id is its conversation id (shared primary key), so a pin is authorized like any
//! other channel access. Any member may pin or unpin; both writes are idempotent and fan out a
//! `message.pinned` / `message.unpinned` event to the channel audience.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{channel_members, channel_pins};
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

use super::authz::{self, ConversationKind};
use super::dto::MessageDto;
use super::error::ApiError;
use super::messages::{hydrate_messages, load_message};

/// The payload carried by a `message.pinned` / `message.unpinned` event.
#[derive(Debug, Serialize)]
struct PinEvent {
    channel_id: Uuid,
    message_id: Uuid,
    by: Uuid,
}

/// Resolve a channel conversation for the caller, rejecting DMs (which cannot be pinned).
async fn ensure_channel(
    state: &AppState,
    channel_id: Uuid,
    user_id: Uuid,
) -> Result<authz::ConversationAccess, ApiError> {
    let access = authz::ensure_conversation_access(&state.db, channel_id, user_id).await?;
    if access.kind != ConversationKind::Channel {
        return Err(ApiError::BadRequest("not a channel"));
    }
    Ok(access)
}

/// Require what it takes to put a landmark in a channel: be in it, and not be a visitor.
///
/// A pin is the one everyday act that changes what *everyone else* sees at the top of a channel, so
/// it is not granted by reading. Until now it was: anyone who could open a public channel could pin
/// and unpin in it, an external guest and a space member who had never joined included.
///
/// A member pins freely, because a channel where only moderators may pin is a channel where nothing
/// is ever pinned. What is held back is the other half: [`unpin_message`] only lets someone take
/// down their own pin, or a moderator take down anyone's.
async fn ensure_may_pin(
    state: &AppState,
    access: &authz::ConversationAccess,
    user_id: Uuid,
) -> Result<(), ApiError> {
    if authz::is_guest(&state.db, access.space_id, user_id).await? {
        return Err(ApiError::Forbidden);
    }
    if channel_members::Entity::find_by_id((access.conversation_id, user_id))
        .one(&state.db)
        .await?
        .is_none()
    {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

/// `GET /api/v1/channels/{channel_id}/pins`: the channel's pinned messages, newest pin first.
#[utoipa::path(
    get,
    path = "/api/v1/channels/{channel_id}/pins",
    tag = "messaging",
    params(("channel_id" = Uuid, Path, description = "Channel id")),
    responses(
        (status = 200, description = "Pinned messages", body = [MessageDto]),
        (status = 403, description = "No access to the channel")
    )
)]
pub async fn list_pins(
    State(state): State<AppState>,
    session: AuthSession,
    Path(channel_id): Path<Uuid>,
) -> Result<Json<Vec<MessageDto>>, ApiError> {
    ensure_channel(&state, channel_id, session.user_id).await?;

    let pins = channel_pins::Entity::find()
        .filter(channel_pins::Column::ChannelId.eq(channel_id))
        .order_by_desc(channel_pins::Column::PinnedAt)
        .all(&state.db)
        .await?;

    let mut rows = Vec::with_capacity(pins.len());
    for pin in pins {
        if let Some(message) = crate::entities::messages::Entity::find_by_id(pin.message_id)
            .one(&state.db)
            .await?
        {
            rows.push(message);
        }
    }
    Ok(Json(
        hydrate_messages(&state.db, session.user_id, rows).await?,
    ))
}

/// `PUT /api/v1/channels/{channel_id}/pins/{message_id}`: pin a message.
#[utoipa::path(
    put,
    path = "/api/v1/channels/{channel_id}/pins/{message_id}",
    tag = "messaging",
    params(
        ("channel_id" = Uuid, Path, description = "Channel id"),
        ("message_id" = Uuid, Path, description = "Message id")
    ),
    responses(
        (status = 204, description = "Message pinned"),
        (status = 400, description = "The message is not in this channel"),
        (status = 403, description = "No access to the channel")
    )
)]
pub async fn pin_message(
    State(state): State<AppState>,
    session: AuthSession,
    Path((channel_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let access = ensure_channel(&state, channel_id, session.user_id).await?;
    ensure_may_pin(&state, &access, session.user_id).await?;
    let message = load_message(&state.db, message_id).await?;
    if message.conversation_id != channel_id {
        return Err(ApiError::BadRequest("message is not in this channel"));
    }

    let already = channel_pins::Entity::find_by_id((channel_id, message_id))
        .one(&state.db)
        .await?
        .is_some();
    if !already {
        channel_pins::ActiveModel {
            channel_id: Set(channel_id),
            message_id: Set(message_id),
            pinned_by: Set(Some(session.user_id)),
            pinned_at: Set(OffsetDateTime::now_utc()),
        }
        .insert(&state.db)
        .await?;

        let audience = authz::conversation_audience(&state.db, &access).await?;
        state
            .hub
            .publish(
                audience,
                RealtimeEnvelope::message_pinned(
                    channel_id,
                    PinEvent {
                        channel_id,
                        message_id,
                        by: session.user_id,
                    },
                ),
            )
            .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/v1/channels/{channel_id}/pins/{message_id}`: unpin a message.
#[utoipa::path(
    delete,
    path = "/api/v1/channels/{channel_id}/pins/{message_id}",
    tag = "messaging",
    params(
        ("channel_id" = Uuid, Path, description = "Channel id"),
        ("message_id" = Uuid, Path, description = "Message id")
    ),
    responses(
        (status = 204, description = "Message unpinned"),
        (status = 403, description = "No access to the channel")
    )
)]
pub async fn unpin_message(
    State(state): State<AppState>,
    session: AuthSession,
    Path((channel_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let access = ensure_channel(&state, channel_id, session.user_id).await?;
    ensure_may_pin(&state, &access, session.user_id).await?;

    // The half that is held back: a pin is a landmark somebody put there on purpose, so taking down
    // one that is not yours is moderation. Yours is always yours to take down, which is what keeps
    // pinning a light gesture rather than one you have to ask permission to undo.
    if let Some(pin) = channel_pins::Entity::find_by_id((channel_id, message_id))
        .one(&state.db)
        .await?
    {
        if pin.pinned_by != Some(session.user_id)
            && !authz::is_channel_moderator(&state.db, channel_id, access.space_id, session.user_id)
                .await?
        {
            return Err(ApiError::Forbidden);
        }
    }

    let result = channel_pins::Entity::delete_by_id((channel_id, message_id))
        .exec(&state.db)
        .await?;
    if result.rows_affected > 0 {
        let audience = authz::conversation_audience(&state.db, &access).await?;
        state
            .hub
            .publish(
                audience,
                RealtimeEnvelope::message_unpinned(
                    channel_id,
                    PinEvent {
                        channel_id,
                        message_id,
                        by: session.user_id,
                    },
                ),
            )
            .await;
    }
    Ok(StatusCode::NO_CONTENT)
}
