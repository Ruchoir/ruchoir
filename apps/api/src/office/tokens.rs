//! Office access tokens: opaque, random, stored in Valkey, one per editing session.
//!
//! The engine presents the token on every WOPI call. It carries nothing readable: it is the key of
//! a record (`office:token:<token>`) naming the member, the file and the mode, which expires with
//! it. Tokens are never logged.

use std::time::{SystemTime, UNIX_EPOCH};

use fred::interfaces::KeysInterface;
use fred::prelude::Pool;
use fred::types::Expiration;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::discovery::Mode;
use super::error::OfficeError;

const PREFIX: &str = "office:token:";

/// What a token allows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub user_id: Uuid,
    pub file_id: Uuid,
    pub mode: Mode,
    /// Unix seconds.
    pub expires_at: i64,
}

/// Mint a token for `user_id` on `file_id`, valid `ttl_secs`.
pub async fn mint(
    valkey: &Pool,
    user_id: Uuid,
    file_id: Uuid,
    mode: Mode,
    ttl_secs: i64,
) -> Result<(String, Grant), OfficeError> {
    let token = random_token()?;
    let grant = Grant {
        user_id,
        file_id,
        mode,
        expires_at: now_secs() + ttl_secs,
    };
    let json = serde_json::to_string(&grant).map_err(|_| OfficeError::Internal)?;
    let key = format!("{PREFIX}{token}");
    let _: () = valkey
        .set(
            key.as_str(),
            json,
            Some(Expiration::EX(ttl_secs)),
            None,
            false,
        )
        .await
        .map_err(|_| OfficeError::Internal)?;
    Ok((token, grant))
}

/// The grant behind a token, or `None` when it is unknown, expired or malformed.
pub async fn resolve(valkey: &Pool, token: &str) -> Result<Option<Grant>, OfficeError> {
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(None);
    }
    let key = format!("{PREFIX}{token}");
    let json: Option<String> = valkey
        .get(key.as_str())
        .await
        .map_err(|_| OfficeError::Internal)?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

fn random_token() -> Result<String, OfficeError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| OfficeError::Internal)?;
    let mut hex = String::with_capacity(64);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
