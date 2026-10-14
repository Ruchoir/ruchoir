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
    /// A one-time credential the import screen hands to an export command, so a script running on
    /// the source host can deliver its sealed archive straight into this instance's import
    /// directory. Short-lived and single-use: it authorises exactly one upload and nothing else.
    ImportDrop,
}

impl TokenPurpose {
    fn prefix(self) -> &'static str {
        match self {
            TokenPurpose::VerifyEmail => "verify_token:",
            TokenPurpose::PasswordReset => "reset_token:",
            TokenPurpose::ImportDrop => "import_drop_token:",
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

// --- The six-digit code sent next to the verification link ---
//
// A link is the way in from a mailbox read on the same device; a code is for everything else (the
// e-mail read on a computer, an app the link does not open). Six digits are guessable where 256 bits
// are not, so the code is kept per account rather than looked up by its own value, and it is spent
// after `CODE_TRIES` wrong answers: the odds of guessing it stay at five in a million per e-mail.

/// Wrong answers a code survives; the next one spends it.
pub const CODE_TRIES: i64 = 5;

fn code_key(user_id: Uuid) -> String {
    format!("verify_code:{user_id}")
}

fn tries_key(user_id: Uuid) -> String {
    format!("verify_code_tries:{user_id}")
}

/// Six decimal digits from the CSPRNG, each value equally likely.
pub fn generate_code() -> Result<String, AuthError> {
    // 4_294_000_000 is the largest multiple of 1_000_000 under 2^32: drawing again above it keeps
    // every code equally likely.
    loop {
        let mut bytes = [0u8; 4];
        getrandom::fill(&mut bytes).map_err(|_| AuthError::Internal)?;
        let value = u32::from_le_bytes(bytes);
        if value < 4_294_000_000 {
            return Ok(format!("{:06}", value % 1_000_000));
        }
    }
}

/// Issue a fresh code for an account, replacing any earlier one and its count of wrong answers.
pub async fn issue_code(valkey: &Pool, user_id: Uuid, ttl_secs: i64) -> Result<String, AuthError> {
    let code = generate_code()?;
    let _: () = valkey
        .set(
            code_key(user_id).as_str(),
            digest(&code),
            Some(Expiration::EX(ttl_secs)),
            None,
            false,
        )
        .await
        .map_err(|_| AuthError::Internal)?;
    let _: () = valkey
        .del(tries_key(user_id).as_str())
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(code)
}

/// Check a code. A match spends it; a wrong answer counts, and the one after the last allowed spends
/// it too, so the person asks for a new e-mail.
pub async fn consume_code(valkey: &Pool, user_id: Uuid, code: &str) -> Result<bool, AuthError> {
    let key = code_key(user_id);
    let stored: Option<String> = valkey
        .get(key.as_str())
        .await
        .map_err(|_| AuthError::Internal)?;
    let Some(stored) = stored else {
        return Ok(false);
    };
    let tries = tries_key(user_id);
    let count: i64 = valkey
        .incr(tries.as_str())
        .await
        .map_err(|_| AuthError::Internal)?;
    if count == 1 {
        // The count lives as long as the code it counts for.
        let ttl: i64 = valkey
            .ttl(key.as_str())
            .await
            .map_err(|_| AuthError::Internal)?;
        let _: () = valkey
            .expire(tries.as_str(), ttl.max(1), None)
            .await
            .map_err(|_| AuthError::Internal)?;
    }
    if count > CODE_TRIES {
        drop_code(valkey, user_id).await?;
        return Ok(false);
    }
    if stored != digest(code) {
        return Ok(false);
    }
    drop_code(valkey, user_id).await?;
    Ok(true)
}

/// Forget an account's code (it was used, or the link confirmed the address first).
pub async fn drop_code(valkey: &Pool, user_id: Uuid) -> Result<(), AuthError> {
    let _: () = valkey
        .del(vec![code_key(user_id), tries_key(user_id)])
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(())
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_is_six_digits() {
        let codes: Vec<String> = (0..200).map(|_| generate_code().expect("code")).collect();
        for code in &codes {
            assert_eq!(code.len(), 6, "{code}");
            assert!(code.bytes().all(|b| b.is_ascii_digit()), "{code}");
        }
        // Drawn, not fixed: two hundred draws are not all the same.
        assert!(codes.iter().any(|c| c != &codes[0]));
    }
}
