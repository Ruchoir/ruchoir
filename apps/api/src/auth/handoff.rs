//! Handing a signed-in account between the instance's web page and the native app (step 6f).
//!
//! A native app cannot run a passkey ceremony for an instance it does not know at build time, so it
//! opens the instance's own page in the system's authentication browser and gets its session back
//! through a single-use code. Two directions:
//!
//! - **Web to app** (signing in): the page, signed in, asks for a *native code* bound to a challenge
//!   the app chose (the SHA-256 of a verifier it keeps, hex). The app trades the code and the
//!   verifier for a session of its own. Whoever sees the code in the redirect cannot use it without
//!   the verifier.
//! - **App to web** (adding a passkey): the app, signed in, asks for a *web handoff* code; the page
//!   it opens redeems it for a short browser session, adds the passkey, and drops that session.
//!
//! Both codes are 256 bits of CSPRNG output, stored only as their digest, for two minutes, and taken
//! with `GETDEL` so a second use finds nothing.

use fred::interfaces::KeysInterface;
use fred::prelude::Pool;
use fred::types::Expiration;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::error::AuthError;
use super::tokens::{digest, generate_token};

const NATIVE_PREFIX: &str = "native_code:";
const WEB_PREFIX: &str = "web_handoff:";
/// Long enough for a browser to hand the code to the app, short enough to be worthless later.
pub const CODE_TTL_SECS: i64 = 120;

/// Whether a challenge has the expected shape: a SHA-256 in lowercase hex.
pub fn plausible_challenge(challenge: &str) -> bool {
    challenge.len() == 64
        && challenge
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Whether `verifier` is the one `challenge` was made from: its SHA-256, in lowercase hex.
pub fn verifier_matches(verifier: &str, challenge: &str) -> bool {
    let plausible = (43..=128).contains(&verifier.len())
        && verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'));
    if !plausible {
        return false;
    }
    let hash = Sha256::digest(verifier.as_bytes());
    let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    // Both sides are public-length hex of a hash: a plain comparison reveals nothing useful.
    hex == challenge
}

/// Issue a native code for a signed-in account, bound to the app's challenge.
pub async fn issue_native_code(
    valkey: &Pool,
    user_id: Uuid,
    challenge: &str,
) -> Result<String, AuthError> {
    let code = generate_token()?;
    let key = format!("{NATIVE_PREFIX}{}", digest(&code));
    let _: () = valkey
        .set(
            key.as_str(),
            format!("{user_id}|{challenge}"),
            Some(Expiration::EX(CODE_TTL_SECS)),
            None,
            false,
        )
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(code)
}

/// Take a native code (single use): the account and the challenge it was bound to.
pub async fn take_native_code(
    valkey: &Pool,
    code: &str,
) -> Result<Option<(Uuid, String)>, AuthError> {
    let key = format!("{NATIVE_PREFIX}{}", digest(code));
    let value: Option<String> = valkey
        .getdel(key.as_str())
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(value.and_then(|v| {
        let (user_id, challenge) = v.split_once('|')?;
        Some((Uuid::parse_str(user_id).ok()?, challenge.to_owned()))
    }))
}

/// Issue a web handoff code for an account signed in on the app.
pub async fn issue_web_handoff(valkey: &Pool, user_id: Uuid) -> Result<String, AuthError> {
    let code = generate_token()?;
    let key = format!("{WEB_PREFIX}{}", digest(&code));
    let _: () = valkey
        .set(
            key.as_str(),
            user_id.to_string(),
            Some(Expiration::EX(CODE_TTL_SECS)),
            None,
            false,
        )
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(code)
}

/// Take a web handoff code (single use): the account it opens a browser session for.
pub async fn take_web_handoff(valkey: &Pool, code: &str) -> Result<Option<Uuid>, AuthError> {
    let key = format!("{WEB_PREFIX}{}", digest(code));
    let value: Option<String> = valkey
        .getdel(key.as_str())
        .await
        .map_err(|_| AuthError::Internal)?;
    Ok(value.and_then(|v| Uuid::parse_str(&v).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // SHA-256 of "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk" (RFC 7636's example verifier), in hex.
    const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const CHALLENGE: &str = "13d31e961a1ad8ec2f16b10c4c982e0876a878ad6df144566ee1894acb70f9c3";

    #[test]
    fn the_verifier_answers_its_challenge() {
        assert!(plausible_challenge(CHALLENGE));
        assert!(verifier_matches(VERIFIER, CHALLENGE));
    }

    #[test]
    fn another_verifier_does_not() {
        assert!(!verifier_matches(
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXK",
            CHALLENGE
        ));
    }

    #[test]
    fn malformed_values_are_refused() {
        assert!(!plausible_challenge("ABC"));
        assert!(!plausible_challenge(&CHALLENGE.to_uppercase()));
        assert!(!verifier_matches("short", CHALLENGE));
        assert!(!verifier_matches(&format!("{VERIFIER} "), CHALLENGE));
    }
}
