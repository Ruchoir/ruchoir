//! `GET` and `PATCH /api/v1/me/preferences`: the caller's own account preferences.
//!
//! Only the session's own user is ever read or written: there is no route to someone else's
//! preferences, an administrator's included. A change is pushed as `preferences.updated` to the
//! caller's own connections (every open device, the one that made it too), with the keys it changed.

use axum::extract::State;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{EntityTrait, QuerySelect, TransactionTrait};
use serde_json::{json, Value};
use time::OffsetDateTime;

use super::document::{join, merge, split, validate_patch, Document};
use crate::auth::extract::AuthSession;
use crate::entities::user_preferences;
use crate::messaging::error::ApiError;
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

fn joined(row: Option<user_preferences::Model>) -> Document {
    row.map(|row| join(row.font, row.emoji_animated, row.ui_state.as_deref()))
        .unwrap_or_default()
}

/// `GET /api/v1/me/preferences`: every account preference the caller has set. A person who never
/// set one reads `{}`: "nothing stored yet" is what tells a device to send its own up.
#[utoipa::path(
    get,
    path = "/api/v1/me/preferences",
    tag = "preferences",
    responses((status = 200, description = "The caller's account preferences", body = Object))
)]
pub async fn get_preferences(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<Json<Document>, ApiError> {
    let row = user_preferences::Entity::find_by_id(session.user_id)
        .one(&state.db)
        .await?;
    Ok(Json(joined(row)))
}

/// `PATCH /api/v1/me/preferences`: change some keys, `null` putting one back to its default. The
/// whole change is refused when one key is unknown or one value invalid.
#[utoipa::path(
    patch,
    path = "/api/v1/me/preferences",
    tag = "preferences",
    request_body = Object,
    responses(
        (status = 200, description = "The whole document after the change", body = Object),
        (status = 400, description = "An unknown key or an invalid value, named in the message")
    )
)]
pub async fn patch_preferences(
    State(state): State<AppState>,
    session: AuthSession,
    Json(patch): Json<Document>,
) -> Result<Json<Document>, ApiError> {
    validate_patch(&patch).map_err(ApiError::BadRequestOwned)?;
    let now = OffsetDateTime::now_utc();

    let txn = state.db.begin().await?;
    // The row first, so that two first changes at once both wait on it rather than racing.
    user_preferences::Entity::insert(user_preferences::ActiveModel {
        user_id: Set(session.user_id),
        updated_at: Set(now),
        ..Default::default()
    })
    .on_conflict_do_nothing()
    .exec(&txn)
    .await?;
    let row = user_preferences::Entity::find_by_id(session.user_id)
        .lock_exclusive()
        .one(&txn)
        .await?;
    let merged = merge(&joined(row), &patch).map_err(ApiError::BadRequestOwned)?;
    let (font, emoji_animated, rest) = split(&merged);
    user_preferences::Entity::update(user_preferences::ActiveModel {
        user_id: Set(session.user_id),
        font: Set(font),
        emoji_animated: Set(emoji_animated),
        ui_state: Set(Some(Value::Object(rest).to_string())),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec(&txn)
    .await?;
    txn.commit().await?;

    if !patch.is_empty() {
        state
            .hub
            .publish(
                vec![session.user_id],
                RealtimeEnvelope::preferences_updated(json!({ "changes": patch })),
            )
            .await;
    }
    Ok(Json(merged))
}
