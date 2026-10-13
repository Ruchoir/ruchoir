//! Opaque server sessions, stored in Valkey.
//!
//! A session id is 256 bits of CSPRNG output, hex-encoded. It carries no data: it is only a
//! lookup key for the record stored at `session:<id>`, which holds the owning user and timestamps.
//! A per-user set at `user_sessions:<user_id>` indexes a user's sessions so they can all be
//! revoked at once ("log out everywhere"). The session record has a sliding idle TTL; the per-user
//! set carries the absolute cap.

use std::time::{SystemTime, UNIX_EPOCH};

use fred::interfaces::{KeysInterface, SetsInterface};
use fred::prelude::Pool;
use fred::types::Expiration;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use axum::http::{header, HeaderMap};
use axum_extra::extract::cookie::CookieJar;
use utoipa::ToSchema;

use super::cookie::SESSION_COOKIE;
use super::error::AuthError;
use crate::config::Config;

const SESSION_PREFIX: &str = "session:";
const USER_SESSIONS_PREFIX: &str = "user_sessions:";

/// The data stored for an active session. `mfa_level` is carried for the MFA step-up that lands in
/// a later step; today a fresh session is `"full"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub user_id: Uuid,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub mfa_level: String,
}

/// How a new session reaches its holder.
///
/// A browser gets the id in the `__Host-` cookie, which its scripts cannot read. A native app has no
/// such jar it controls, so it receives the id itself, keeps it in the device's keychain and sends it
/// back as `Authorization: Bearer`. The session behind both is the same record, with the same limits.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Delivery {
    #[default]
    Cookie,
    Token,
}

/// The session id a request presents: the cookie when there is one, else a bearer token.
///
/// Anything that is not a plain `Bearer <id>` with an id made of letters and digits presents no
/// session at all, so a malformed header is a 401 rather than a strange Valkey key.
pub fn presented_id(headers: &HeaderMap) -> Option<String> {
    if let Some(cookie) = CookieJar::from_headers(headers).get(SESSION_COOKIE) {
        return Some(cookie.value().to_owned());
    }
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, id) = value.split_once(' ')?;
    let id = id.trim();
    let plausible =
        !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric());
    (scheme.eq_ignore_ascii_case("bearer") && plausible).then(|| id.to_owned())
}

/// Whether a request was sent by a browser.
///
/// Browsers name where a write comes from, in `Sec-Fetch-Site` and, on every POST, in `Origin`; a
/// native HTTP client sends neither. This is what keeps a session token out of a page's reach: a
/// script running in the web app could otherwise ask for one and carry it away, where the cookie it
/// rides on can never leave the browser.
pub fn from_browser(headers: &HeaderMap) -> bool {
    headers.contains_key("sec-fetch-site") || headers.contains_key(header::ORIGIN)
}

/// Create a new session for a user and return its opaque id.
pub async fn create(valkey: &Pool, config: &Config, user_id: Uuid) -> Result<String, AuthError> {
    let id = generate_id()?;
    let now = now_secs();
    let record = SessionRecord {
        user_id,
        created_at: now,
        last_seen_at: now,
        mfa_level: "full".to_string(),
    };
    let json = serde_json::to_string(&record).map_err(|_| AuthError::Internal)?;

    let session_key = format!("{SESSION_PREFIX}{id}");
    let user_key = format!("{USER_SESSIONS_PREFIX}{user_id}");

    let _: () = valkey
        .set(
            session_key.as_str(),
            json,
            Some(Expiration::EX(config.session_idle_ttl_secs)),
            None,
            false,
        )
        .await
        .map_err(|_| AuthError::Internal)?;
    let _: () = valkey
        .sadd(user_key.as_str(), id.as_str())
        .await
        .map_err(|_| AuthError::Internal)?;
    let _: () = valkey
        .expire(user_key.as_str(), config.session_absolute_ttl_secs, None)
        .await
        .map_err(|_| AuthError::Internal)?;

    Ok(id)
}

/// Look up a session by id, returning `None` if it is absent or expired.
pub async fn get(valkey: &Pool, id: &str) -> Result<Option<SessionRecord>, AuthError> {
    let session_key = format!("{SESSION_PREFIX}{id}");
    let json: Option<String> = valkey
        .get(session_key.as_str())
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

/// Resolve an active session by id for the authorization guard: enforce the absolute lifetime
/// cap and, if still valid, refresh the sliding idle window. Returns `None` when the session is
/// absent or past its absolute cap (revoking it in that case), which the caller maps to a 401.
pub async fn resolve(
    valkey: &Pool,
    config: &Config,
    id: &str,
) -> Result<Option<SessionRecord>, AuthError> {
    let Some(record) = get(valkey, id).await? else {
        return Ok(None);
    };
    let now = now_secs();
    if record
        .created_at
        .saturating_add(config.session_absolute_ttl_secs)
        <= now
    {
        delete(valkey, id).await?;
        return Ok(None);
    }
    // Sliding refresh: every authenticated request pushes the idle expiry out.
    let session_key = format!("{SESSION_PREFIX}{id}");
    let _: () = valkey
        .expire(session_key.as_str(), config.session_idle_ttl_secs, None)
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(Some(record))
}

/// Revoke a single session and drop it from its owner's index.
pub async fn delete(valkey: &Pool, id: &str) -> Result<(), AuthError> {
    if let Some(record) = get(valkey, id).await? {
        let user_key = format!("{USER_SESSIONS_PREFIX}{}", record.user_id);
        let _: () = valkey
            .srem(user_key.as_str(), id)
            .await
            .map_err(|_| AuthError::Internal)?;
    }
    let session_key = format!("{SESSION_PREFIX}{id}");
    let _: () = valkey
        .del(session_key.as_str())
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(())
}

/// Revoke every session belonging to a user ("log out everywhere").
pub async fn delete_all(valkey: &Pool, user_id: Uuid) -> Result<(), AuthError> {
    let user_key = format!("{USER_SESSIONS_PREFIX}{user_id}");
    let ids: Vec<String> = valkey
        .smembers(user_key.as_str())
        .await
        .map_err(|_| AuthError::Internal)?;
    for id in &ids {
        let session_key = format!("{SESSION_PREFIX}{id}");
        let _: () = valkey
            .del(session_key.as_str())
            .await
            .map_err(|_| AuthError::Internal)?;
    }
    let _: () = valkey
        .del(user_key.as_str())
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(())
}

/// Current unix time in seconds.
fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Generate a 256-bit opaque session id, hex-encoded.
fn generate_id() -> Result<String, AuthError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| AuthError::Internal)?;
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}
