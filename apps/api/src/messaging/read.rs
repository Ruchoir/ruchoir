//! Read cursors: where each member of a conversation has read up to.
//!
//! Read state is a single per-(conversation, user) cursor, not a per-message receipt: lighter, and
//! it answers the same questions. One cursor plus the order of the messages says who has seen any
//! given one.
//!
//! The cursor used to be the caller's own business, pushed only to their own connections. It is now
//! readable by the other members of the same conversation, which is what a read receipt is: the
//! people you are talking to learn that you have seen what they wrote. It goes no further than that
//! conversation, and it is still one cursor, so nothing records *when* a particular message was
//! opened, only how far along someone is.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter};
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::read_cursors;
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

use super::authz;
use super::dto::ReadRequest;
use super::error::ApiError;
use super::messages::load_message;

/// The payload carried by a `read.updated` event.
///
/// `user_id` is what makes it usable by anyone but its author: the event reaches the whole
/// conversation now, and a cursor with no owner cannot be attributed to a person.
#[derive(Debug, Serialize)]
struct ReadEvent {
    conversation_id: Uuid,
    user_id: Uuid,
    last_read_message_id: Uuid,
}

/// One member's cursor, as `GET /conversations/{id}/read` returns it.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ReadCursorDto {
    pub user_id: Uuid,
    /// The last message this member has read; absent when they have read nothing here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_read_message_id: Option<Uuid>,
}

/// `GET /api/v1/conversations/{conversation_id}/read`: how far each member has read.
///
/// The caller's own cursor is included: a client showing its own unread marker needs it, and
/// withholding it would only mean fetching it somewhere else.
#[utoipa::path(
    get,
    path = "/api/v1/conversations/{conversation_id}/read",
    tag = "messaging",
    params(("conversation_id" = Uuid, Path, description = "Conversation id")),
    responses(
        (status = 200, description = "Each member's read cursor", body = [ReadCursorDto]),
        (status = 403, description = "No access to the conversation")
    )
)]
pub async fn get_read_cursors(
    State(state): State<AppState>,
    session: AuthSession,
    Path(conversation_id): Path<Uuid>,
) -> Result<Json<Vec<ReadCursorDto>>, ApiError> {
    let access =
        authz::ensure_conversation_access(&state.db, conversation_id, session.user_id).await?;

    // One row per member, including those who have read nothing here and so have no cursor stored.
    // Without them the client knows who has read but not how many people could have, and cannot
    // tell "everyone" from "three of them": a count is only meaningful against its total.
    let audience = authz::conversation_audience(&state.db, &access).await?;
    let cursors: HashMap<Uuid, Option<Uuid>> = read_cursors::Entity::find()
        .filter(read_cursors::Column::ConversationId.eq(conversation_id))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|c| (c.user_id, c.last_read_message_id))
        .collect();

    Ok(Json(
        audience
            .into_iter()
            .map(|user_id| ReadCursorDto {
                user_id,
                last_read_message_id: cursors.get(&user_id).copied().flatten(),
            })
            .collect(),
    ))
}

/// `PUT /api/v1/conversations/{conversation_id}/read`: move the caller's read cursor.
#[utoipa::path(
    put,
    path = "/api/v1/conversations/{conversation_id}/read",
    tag = "messaging",
    params(("conversation_id" = Uuid, Path, description = "Conversation id")),
    request_body = ReadRequest,
    responses(
        (status = 204, description = "Read cursor updated"),
        (status = 400, description = "The message is not in this conversation"),
        (status = 403, description = "No access to the conversation")
    )
)]
pub async fn set_read_cursor(
    State(state): State<AppState>,
    session: AuthSession,
    Path(conversation_id): Path<Uuid>,
    Json(body): Json<ReadRequest>,
) -> Result<StatusCode, ApiError> {
    let access =
        authz::ensure_conversation_access(&state.db, conversation_id, session.user_id).await?;

    // The cursor must point at a message that actually belongs to this conversation.
    let message = load_message(&state.db, body.last_read_message_id).await?;
    if message.conversation_id != conversation_id {
        return Err(ApiError::BadRequest("message is not in this conversation"));
    }

    let now = OffsetDateTime::now_utc();
    match read_cursors::Entity::find_by_id((conversation_id, session.user_id))
        .one(&state.db)
        .await?
    {
        Some(existing) => {
            let mut active = existing.into_active_model();
            active.last_read_message_id = Set(Some(body.last_read_message_id));
            active.updated_at = Set(now);
            active.update(&state.db).await?;
        }
        None => {
            read_cursors::ActiveModel {
                conversation_id: Set(conversation_id),
                user_id: Set(session.user_id),
                last_read_message_id: Set(Some(body.last_read_message_id)),
                updated_at: Set(now),
            }
            .insert(&state.db)
            .await?;
        }
    }

    // The caller's other devices, and the people they are talking to: the first keeps their unread
    // badges in step, the second is the read receipt.
    let audience = authz::conversation_audience(&state.db, &access).await?;
    state
        .hub
        .publish(
            audience,
            RealtimeEnvelope::read_updated(
                conversation_id,
                ReadEvent {
                    conversation_id,
                    user_id: session.user_id,
                    last_read_message_id: body.last_read_message_id,
                },
            ),
        )
        .await;

    Ok(StatusCode::NO_CONTENT)
}
