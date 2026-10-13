//! Transient state for the login MFA step-up.
//!
//! When an MFA-enforced account passes the password check, no session is opened yet. Instead a
//! short-lived pending token is stored in Valkey (mapping to the user id) and returned to the
//! client, which then completes a second factor (TOTP, passkey or recovery code) against it. On
//! success the token is consumed and a full session is issued.

use fred::interfaces::KeysInterface;
use fred::prelude::Pool;
use fred::types::Expiration;
use uuid::Uuid;

use super::error::AuthError;
use super::session::Delivery;

const PENDING_PREFIX: &str = "mfa_pending:";
/// The user has a few minutes to complete the second factor.
const PENDING_TTL_SECS: i64 = 300;

/// Open a pending MFA step-up for a user and return its opaque token.
///
/// The value remembers how the session is to be delivered once the second factor passes, so an
/// app that asked for a token at the password step gets one at the end of the step-up too. It is
/// the bare user id for a cookie (the format written before native sessions existed, still read)
/// and `<user id>|token` for a token.
pub async fn start_pending(
    valkey: &Pool,
    user_id: Uuid,
    delivery: Delivery,
) -> Result<String, AuthError> {
    let token = generate_token()?;
    let key = format!("{PENDING_PREFIX}{token}");
    let value = match delivery {
        Delivery::Cookie => user_id.to_string(),
        Delivery::Token => format!("{user_id}|token"),
    };
    let _: () = valkey
        .set(
            key.as_str(),
            value,
            Some(Expiration::EX(PENDING_TTL_SECS)),
            None,
            false,
        )
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(token)
}

/// Resolve a pending token to its user id without consuming it (allows a retry on a wrong code).
pub async fn resolve_pending(valkey: &Pool, token: &str) -> Result<Option<Uuid>, AuthError> {
    Ok(resolve_pending_delivery(valkey, token)
        .await?
        .map(|(user_id, _)| user_id))
}

/// Resolve a pending token to its user id and the delivery chosen at the password step.
pub async fn resolve_pending_delivery(
    valkey: &Pool,
    token: &str,
) -> Result<Option<(Uuid, Delivery)>, AuthError> {
    let key = format!("{PENDING_PREFIX}{token}");
    let value: Option<String> = valkey
        .get(key.as_str())
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(value.and_then(|v| parse_pending(&v)))
}

fn parse_pending(value: &str) -> Option<(Uuid, Delivery)> {
    match value.split_once('|') {
        None => Some((Uuid::parse_str(value).ok()?, Delivery::Cookie)),
        Some((user_id, "token")) => Some((Uuid::parse_str(user_id).ok()?, Delivery::Token)),
        Some(_) => None,
    }
}

/// Consume a pending token after a successful second factor.
pub async fn consume_pending(valkey: &Pool, token: &str) -> Result<(), AuthError> {
    let key = format!("{PENDING_PREFIX}{token}");
    let _: () = valkey
        .del(key.as_str())
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(())
}

fn generate_token() -> Result<String, AuthError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| AuthError::Internal)?;
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_user_id_is_a_cookie_step_up() {
        // Written before native sessions existed, and still in Valkey for five minutes after a
        // deployment: it must keep completing as the cookie login it was.
        let id = Uuid::new_v4();
        assert_eq!(parse_pending(&id.to_string()), Some((id, Delivery::Cookie)));
    }

    #[test]
    fn a_token_step_up_is_read_back() {
        let id = Uuid::new_v4();
        assert_eq!(
            parse_pending(&format!("{id}|token")),
            Some((id, Delivery::Token))
        );
    }

    #[test]
    fn anything_else_is_no_step_up() {
        let id = Uuid::new_v4();
        assert_eq!(parse_pending(&format!("{id}|other")), None);
        assert_eq!(parse_pending("not-a-uuid"), None);
    }
}
