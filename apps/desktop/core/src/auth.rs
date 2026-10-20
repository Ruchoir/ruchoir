//! Signing in through the instance's own page, as the phone does for passkeys (ADR 0005, step 6f).
//!
//! The app draws a verifier only it will ever hold and opens `https://<instance>/n/?c=<challenge>`
//! in the system browser, the challenge being the verifier's SHA-256. There the person signs in as
//! on the web (password, then a code or a passkey) and allows the app; the page hands a single-use
//! code back on `ruchoir://auth?code=...`. The app trades the code and its verifier for a session
//! token, which goes straight to the keychain: the interface never sees it.

use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// How long the app waits for the page to come back. The code itself lives two minutes on the
/// instance; this only bounds how long an old browser tab can still complete a sign-in.
pub const PENDING_FOR: Duration = Duration::from_secs(10 * 60);

/// A sign-in started and not yet finished.
#[derive(Debug, Clone)]
pub struct PendingSignIn {
    pub instance_id: String,
    verifier: String,
    /// Lowercase hex SHA-256 of the verifier, the form `handoff::plausible_challenge` accepts.
    pub challenge: String,
    pub started: Instant,
}

impl PendingSignIn {
    /// The secret half, sent only to the instance's exchange.
    pub fn verifier(&self) -> &str {
        &self.verifier
    }

    fn expired(&self) -> bool {
        self.started.elapsed() > PENDING_FOR
    }
}

/// Why the exchange did not give a session.
#[derive(Debug)]
pub enum AuthError {
    /// The instance could not be reached.
    Network(String),
    /// The instance refused the code (expired, used, or not for this verifier).
    Refused(u16),
    /// The answer carried no token.
    Malformed,
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::Network(e) => write!(f, "network: {e}"),
            AuthError::Refused(status) => write!(f, "refused ({status})"),
            AuthError::Malformed => f.write_str("malformed answer"),
        }
    }
}

/// Start a sign-in for `instance_id`: a fresh verifier (32 random bytes, 64 hex characters) and its
/// challenge.
pub fn begin(instance_id: &str) -> PendingSignIn {
    let verifier = crate::instances::random_hex(32);
    let challenge = Sha256::digest(verifier.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    PendingSignIn {
        instance_id: instance_id.to_string(),
        verifier,
        challenge,
        started: Instant::now(),
    }
}

/// The page the system browser opens.
pub fn sign_in_url(origin: &str, pending: &PendingSignIn) -> String {
    format!("{origin}/n/?c={}", pending.challenge)
}

/// The code of a `ruchoir://auth?code=...` link; `None` for any other link.
pub fn code_from_deep_link(link: &str) -> Option<String> {
    let url = url::Url::parse(link).ok()?;
    if url.scheme() != "ruchoir" || url.host_str() != Some("auth") {
        return None;
    }
    url.query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
        .filter(|code| !code.is_empty())
}

/// Trade the page's code and the verifier for a session token. Sent without `Origin` (the instance
/// refuses a token to anything that looks like a browser).
pub async fn exchange(
    http: &reqwest::Client,
    origin: &str,
    code: &str,
    pending: &PendingSignIn,
) -> Result<String, AuthError> {
    let response = http
        .post(format!("{origin}/api/v1/auth/native/exchange"))
        .json(&serde_json::json!({ "code": code, "verifier": pending.verifier }))
        .send()
        .await
        .map_err(|e| AuthError::Network(e.to_string()))?;
    if !response.status().is_success() {
        return Err(AuthError::Refused(response.status().as_u16()));
    }
    let body: serde_json::Value = response.json().await.map_err(|_| AuthError::Malformed)?;
    body.get("session_token")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .ok_or(AuthError::Malformed)
}

/// Finish a sign-in from a deep link. `None` when the link is to be ignored: no sign-in pending, a
/// pending one too old, or a link that is not a sign-in. Nothing is sent to the instance then.
pub async fn complete(
    http: &reqwest::Client,
    pending: Option<&PendingSignIn>,
    origin: &str,
    link: &str,
) -> Option<Result<String, AuthError>> {
    let pending = pending.filter(|p| !p.expired())?;
    let code = code_from_deep_link(link)?;
    Some(exchange(http, origin, &code, pending).await)
}
