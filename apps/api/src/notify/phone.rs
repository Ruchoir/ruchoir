//! Phone notifications (ADR 0006): the phones that allowed them, and waking them through the
//! publisher's relay.
//!
//! The instance never holds Apple's or Google's keys. It posts a device's token to the relay
//! (`Config::push_relay_url`), which sends a constant push; the phone then asks this instance what
//! to show (`GET /api/v1/push/pending`, as the browsers' service worker does). Which notifications
//! wake a phone is decided where the browsers' are ([`super::push`]): same preferences, same quiet
//! hours, same administrator switch.

use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use sea_orm::sea_query::OnConflict;
use sea_orm::ActiveValue::Set;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde::Deserialize;
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::push_devices;
use crate::messaging::error::ApiError;
use crate::state::AppState;

/// A phone unseen this long (its app not opened) is forgotten.
const STALE_DAYS: i64 = 60;

/// A phone, as its app registers it.
#[derive(Debug, Deserialize, ToSchema)]
pub struct DeviceRequest {
    /// `ios` or `android`.
    pub platform: String,
    /// The device token Apple or Google handed the app.
    pub token: String,
}

/// A phone to forget.
#[derive(Debug, Deserialize, ToSchema)]
pub struct DeviceToken {
    pub token: String,
}

/// Whether `token` looks like what `platform`'s vendor hands out: hex from Apple, a short
/// alphabet from Google. Checked here so the relay is never asked about anything else.
pub fn plausible(platform: &str, token: &str) -> bool {
    match platform {
        "ios" => (32..=400).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit()),
        "android" => {
            (20..=4096).contains(&token.len())
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'))
        }
        _ => false,
    }
}

/// `PUT /api/v1/push/devices`: remember this phone for the caller, or refresh it.
///
/// Keyed by token: the same phone registering again refreshes its row, and a phone someone else
/// signed in on is handed to the caller rather than waking two accounts.
#[utoipa::path(
    put,
    path = "/api/v1/push/devices",
    tag = "notifications",
    request_body = DeviceRequest,
    responses(
        (status = 204, description = "Phone remembered"),
        (status = 400, description = "Not a device token"),
        (status = 409, description = "Notifications to phones are off on this instance")
    )
)]
pub async fn register(
    State(state): State<AppState>,
    session: AuthSession,
    Json(body): Json<DeviceRequest>,
) -> Result<StatusCode, ApiError> {
    let settings = crate::admin::instance_settings(&state.db).await?;
    if !settings.web_push_enabled || state.config.push_relay_url.is_none() {
        return Err(ApiError::Conflict(
            "notifications to phones are off on this instance",
        ));
    }
    if !plausible(&body.platform, &body.token) {
        return Err(ApiError::BadRequest("not a device token"));
    }
    let now = OffsetDateTime::now_utc();
    push_devices::Entity::insert(push_devices::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(session.user_id),
        platform: Set(body.platform),
        token: Set(body.token),
        created_at: Set(now),
        last_seen_at: Set(now),
    })
    .on_conflict(
        OnConflict::column(push_devices::Column::Token)
            .update_columns([
                push_devices::Column::UserId,
                push_devices::Column::Platform,
                push_devices::Column::LastSeenAt,
            ])
            .to_owned(),
    )
    .exec(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/v1/push/devices`: forget this phone (the app signing out). Idempotent, and only
/// ever the caller's own.
#[utoipa::path(
    delete,
    path = "/api/v1/push/devices",
    tag = "notifications",
    request_body = DeviceToken,
    responses((status = 204, description = "Forgotten (or was not known)"))
)]
pub async fn unregister(
    State(state): State<AppState>,
    session: AuthSession,
    Json(body): Json<DeviceToken>,
) -> Result<StatusCode, ApiError> {
    push_devices::Entity::delete_many()
        .filter(push_devices::Column::Token.eq(body.token))
        .filter(push_devices::Column::UserId.eq(session.user_id))
        .exec(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Forget every phone of an account, when all its sessions end (signing out everywhere, a new
/// password): a phone that is signed out must not keep being woken.
pub async fn forget_user(db: &DatabaseConnection, user_id: Uuid) {
    if let Err(error) = push_devices::Entity::delete_many()
        .filter(push_devices::Column::UserId.eq(user_id))
        .exec(db)
        .await
    {
        tracing::warn!(%error, "could not forget an account's phones");
    }
}

/// The phones of an account worth waking, forgetting those unseen for too long.
pub async fn devices(
    db: &DatabaseConnection,
    user_id: Uuid,
    now: OffsetDateTime,
) -> Result<Vec<push_devices::Model>, ApiError> {
    let floor = now - time::Duration::days(STALE_DAYS);
    push_devices::Entity::delete_many()
        .filter(push_devices::Column::UserId.eq(user_id))
        .filter(push_devices::Column::LastSeenAt.lt(floor))
        .exec(db)
        .await?;
    Ok(push_devices::Entity::find()
        .filter(push_devices::Column::UserId.eq(user_id))
        .all(db)
        .await?)
}

/// The shared HTTP client for the relay: rustls with `ring`, a short timeout, every status handed
/// back.
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(15)))
            .http_status_as_error(false)
            .max_redirects(0)
            .build()
            .into()
    })
}

/// Wake one phone through the relay; a phone the vendor says is gone is forgotten.
pub async fn wake(state: &AppState, device: push_devices::Model) {
    let Some(relay) = state.config.push_relay_url.clone() else {
        return;
    };
    let body =
        serde_json::json!({ "platform": device.platform, "token": device.token }).to_string();
    let result = tokio::task::spawn_blocking(move || {
        agent()
            .post(&format!("{relay}/v1/send"))
            .header("Content-Type", "application/json")
            .send(body.as_bytes())
            .map(|response| response.status().as_u16())
    })
    .await;
    match result {
        Ok(Ok(200..=299)) => {}
        Ok(Ok(410)) => {
            tracing::info!(device = %device.id, "phone gone; forgotten");
            if let Err(error) = push_devices::Entity::delete_by_id(device.id)
                .exec(&state.db)
                .await
            {
                tracing::warn!(%error, "could not forget a phone");
            }
        }
        Ok(Ok(status)) => tracing::warn!(status, device = %device.id, "the push relay refused"),
        Ok(Err(error)) => tracing::warn!(%error, "could not reach the push relay"),
        Err(error) => tracing::warn!(%error, "push relay task failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::plausible;

    #[test]
    fn device_tokens_are_checked_per_platform() {
        assert!(plausible("ios", &"ab12".repeat(16)));
        assert!(!plausible("ios", "not-hex-at-all-not-hex-at-all-not-hex"));
        assert!(plausible(
            "android",
            "dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8"
        ));
        assert!(!plausible("android", "short"));
        assert!(!plausible("windows", &"ab12".repeat(16)));
    }
}
