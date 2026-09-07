//! Single-use, expiring email tokens (address verification, password reset).
//!
//! A token is 256 bits of CSPRNG output, sent to the user in a link. Only its SHA-256 digest is
//! stored in Valkey (keyed by purpose) mapped to the owning user id, with a TTL. Storing the hash
//! (not the raw token) means a Valkey dump does not yield usable tokens. Consuming a token is a
//! single atomic `GETDEL`, so a token works exactly once.

use fred::interfaces::KeysInterface;
use fred::prelude::Pool;
use fred::types::Expiration;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::error::AuthError;

/// What a token authorizes.
#[derive(Clone, Copy)]
pub enum TokenPurpose {
    VerifyEmail,
    PasswordReset,
}

impl TokenPurpose {
    fn prefix(self) -> &'static str {
        match self {
            TokenPurpose::VerifyEmail => "verify_token:",
            TokenPurpose::PasswordReset => "reset_token:",
        }
    }
}

/// Issue a token for a user and return the raw value to embed in a link.
pub async fn issue(
    valkey: &Pool,
    purpose: TokenPurpose,
    user_id: Uuid,
    ttl_secs: i64,
) -> Result<String, AuthError> {
    let raw = generate_token()?;
    let key = storage_key(purpose, &raw);
    let _: () = valkey
        .set(
            key.as_str(),
            user_id.to_string(),
            Some(Expiration::EX(ttl_secs)),
            None,
            false,
        )
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(raw)
}

/// Consume a token, returning the user id it was issued for. The token is invalidated atomically,
/// so a second use fails.
pub async fn consume(
    valkey: &Pool,
    purpose: TokenPurpose,
    raw: &str,
) -> Result<Option<Uuid>, AuthError> {
    let key = storage_key(purpose, raw);
    let value: Option<String> = valkey
        .getdel(key.as_str())
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(value.and_then(|v| Uuid::parse_str(&v).ok()))
}

fn storage_key(purpose: TokenPurpose, raw: &str) -> String {
    format!("{}{}", purpose.prefix(), digest(raw))
}

/// SHA-256 of a raw token, hex encoded: the only form a token is ever stored in.
///
/// Shared with the space-invitation flow, which keeps its digests in PostgreSQL rather than Valkey
/// (an invitation is listable and revocable, not fire-and-forget) but must not weaken the rule that
/// no store ever holds a usable token.
pub fn digest(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    to_hex(&hasher.finalize())
}

/// A fresh 256-bit token from the CSPRNG, hex encoded. Also used for invitation tokens.
pub fn generate_token() -> Result<String, AuthError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| AuthError::Internal)?;
    Ok(to_hex(&bytes))
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}
