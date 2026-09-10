//! Presence: ephemeral live status plus the persistent manual override.
//!
//! Two inputs combine into the presence a viewer sees:
//!
//! - **Live heartbeat** (ephemeral): while a user holds a real-time connection, the connection
//!   refreshes a Valkey key `presence:<user_id>` with a short TTL. Present key => reachable now.
//!   Nothing is written to PostgreSQL; the key simply lapses when the last connection goes away.
//! - **Manual override** (persistent): `users.manual_presence` (`active`/`away`/`dnd`/`invisible`,
//!   or `NULL` for automatic). A deliberate choice always wins over the heartbeat, and `invisible`
//!   makes the user appear offline to everyone else while still using the app.
//!
//! The effective status is computed server-side so the rule lives in exactly one place. A change
//! (connect, disconnect, or an override edit) is pushed to the user's space co-members.

use axum::extract::{Path, State};
use axum::Json;
use fred::interfaces::KeysInterface;
use fred::prelude::Pool;
use fred::types::Expiration;
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter};
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::users;
use crate::messaging::authz;
use crate::messaging::dto::{PresenceDto, SetPresenceRequest};
use crate::messaging::error::ApiError;
use crate::state::AppState;

const PRESENCE_PREFIX: &str = "presence:";

/// The manual-override values accepted on `users.manual_presence`.
const MANUAL_VALUES: [&str; 4] = ["active", "away", "dnd", "invisible"];

/// Refresh a user's live heartbeat with the configured TTL.
pub async fn heartbeat(valkey: &Pool, user_id: Uuid, ttl_secs: i64) {
    let key = format!("{PRESENCE_PREFIX}{user_id}");
    if let Err(error) = valkey
        .set::<(), _, _>(key, "1", Some(Expiration::EX(ttl_secs)), None, false)
        .await
    {
        tracing::warn!(%error, "failed to write presence heartbeat");
    }
}

/// Clear a user's live heartbeat (called when their last local connection drops).
pub async fn clear(valkey: &Pool, user_id: Uuid) {
    let key = format!("{PRESENCE_PREFIX}{user_id}");
    let _ = valkey.del::<u64, _>(key).await;
}

/// Whether a user currently has a live heartbeat.
pub async fn is_online(valkey: &Pool, user_id: Uuid) -> bool {
    let key = format!("{PRESENCE_PREFIX}{user_id}");
    matches!(valkey.exists::<u64, _>(key).await, Ok(n) if n > 0)
}

/// The presence a *third party* sees. `invisible` and an absent heartbeat both read as `offline`.
///
/// An override says how to read someone who is reachable; it does not make them reachable. Without
/// a heartbeat the answer is `offline` whatever they chose, because the alternative is a dot that
/// claims a colleague is there when nothing of theirs is connected. `active` is the case that made
/// this visible: it was returned even with the heartbeat long lapsed, so anyone who had once
/// picked "online" stayed green to the whole space for good.
pub fn effective_for_others(manual: Option<&str>, online: bool) -> &'static str {
    if !online {
        return "offline";
    }
    match manual {
        Some("invisible") => "offline",
        Some("dnd") => "dnd",
        Some("away") => "away",
        _ => "active",
    }
}

/// The presence a user sees for *themselves* (keeps `invisible` visible in their own UI).
///
/// Their own choice is shown back to them even while nothing is connected, so the menu reflects
/// what they picked rather than silently disagreeing with it. What everyone else sees is still
/// [`effective_for_others`], which needs a heartbeat.
fn effective_for_self(manual: Option<&str>, online: bool) -> &'static str {
    match manual {
        Some("invisible") => "invisible",
        Some("dnd") => "dnd",
        Some("away") => "away",
        Some("active") => "active",
        _ => {
            if online {
                "active"
            } else {
                "offline"
            }
        }
    }
}

/// `GET /api/v1/spaces/{space_id}/presence`: a snapshot of every member's presence.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/presence",
    tag = "realtime",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "Presence of the space's members", body = [PresenceDto]),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn get_space_presence(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Json<Vec<PresenceDto>>, ApiError> {
    let member_ids = authz::space_member_ids(&state.db, space_id, session.user_id).await?;
    let members = users::Entity::find()
        .filter(users::Column::Id.is_in(member_ids.iter().copied()))
        .all(&state.db)
        .await?;

    let mut out = Vec::with_capacity(members.len());
    for member in members {
        let online = is_online(state.hub.valkey(), member.id).await;
        let manual = member.manual_presence.as_deref();
        let presence = if member.id == session.user_id {
            effective_for_self(manual, online)
        } else {
            effective_for_others(manual, online)
        };
        out.push(PresenceDto {
            user_id: member.id,
            presence: presence.to_string(),
        });
    }
    Ok(Json(out))
}

/// `PUT /api/v1/me/presence`: set or clear the caller's manual override, then broadcast the change.
#[utoipa::path(
    put,
    path = "/api/v1/me/presence",
    tag = "realtime",
    request_body = SetPresenceRequest,
    responses(
        (status = 200, description = "Updated own presence", body = PresenceDto),
        (status = 400, description = "Invalid presence value")
    )
)]
pub async fn set_my_presence(
    State(state): State<AppState>,
    session: AuthSession,
    Json(body): Json<SetPresenceRequest>,
) -> Result<Json<PresenceDto>, ApiError> {
    let manual = match body.manual_presence.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(value) if MANUAL_VALUES.contains(&value) => Some(value.to_string()),
        Some(_) => return Err(ApiError::BadRequest("unknown presence value")),
    };

    let user = users::Entity::find_by_id(session.user_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    let mut active = user.into_active_model();
    active.manual_presence = Set(manual.clone());
    active.update(&state.db).await?;

    broadcast_presence(&state, session.user_id, manual.as_deref()).await?;

    let online = is_online(state.hub.valkey(), session.user_id).await;
    Ok(Json(PresenceDto {
        user_id: session.user_id,
        presence: effective_for_self(manual.as_deref(), online).to_string(),
    }))
}

/// Publish a user's current effective (as-others-see-it) presence to their space co-members.
pub async fn broadcast_presence(
    state: &AppState,
    user_id: Uuid,
    manual: Option<&str>,
) -> Result<(), ApiError> {
    let online = is_online(state.hub.valkey(), user_id).await;
    let presence = effective_for_others(manual, online);
    let audience = authz::space_co_members(&state.db, user_id).await?;
    let envelope = super::event::RealtimeEnvelope::presence(PresenceDto {
        user_id,
        presence: presence.to_string(),
    });
    state.hub.publish(audience, envelope).await;
    Ok(())
}

/// Look up a user's manual override, then broadcast presence. Used by the transport on connect and
/// disconnect, where the override is not already in hand.
pub async fn refresh_and_broadcast(state: &AppState, user_id: Uuid) {
    let manual = match users::Entity::find_by_id(user_id).one(&state.db).await {
        Ok(Some(user)) => user.manual_presence,
        _ => None,
    };
    if let Err(error) = broadcast_presence(state, user_id, manual.as_deref()).await {
        tracing::warn!(?error, "failed to broadcast presence change");
    }
}

#[cfg(test)]
mod tests {
    use super::{effective_for_others, effective_for_self};

    #[test]
    fn auto_presence_follows_the_heartbeat() {
        assert_eq!(effective_for_others(None, true), "active");
        assert_eq!(effective_for_others(None, false), "offline");
    }

    #[test]
    fn invisible_reads_as_offline_to_others_but_visible_to_self() {
        assert_eq!(effective_for_others(Some("invisible"), true), "offline");
        assert_eq!(effective_for_self(Some("invisible"), true), "invisible");
    }

    #[test]
    fn an_override_colours_a_live_connection() {
        assert_eq!(effective_for_others(Some("dnd"), true), "dnd");
        assert_eq!(effective_for_others(Some("away"), true), "away");
        assert_eq!(effective_for_others(Some("active"), true), "active");
    }

    #[test]
    fn no_override_makes_an_absent_user_look_present() {
        // The rule that matters: a choice says how to read someone who is reachable, it does not
        // make them reachable. Anything else leaves a colleague green with nothing connected.
        for manual in [
            None,
            Some("active"),
            Some("away"),
            Some("dnd"),
            Some("invisible"),
        ] {
            assert_eq!(effective_for_others(manual, false), "offline");
        }
    }

    #[test]
    fn a_user_still_sees_their_own_choice_while_disconnected() {
        assert_eq!(effective_for_self(Some("away"), false), "away");
        assert_eq!(effective_for_self(None, false), "offline");
    }
}
