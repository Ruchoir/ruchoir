//! Google's push service (FCM HTTP v1), authenticated with the Firebase project's service account:
//! a JWT signed (RS256) with its key, traded for an access token that lasts an hour.

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::{Kind, Outcome, Pusher};

const SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";

/// The parts of a service-account JSON file the relay needs.
#[derive(Deserialize)]
pub struct ServiceAccount {
    pub project_id: String,
    pub client_email: String,
    pub private_key: String,
    #[serde(default)]
    pub token_uri: Option<String>,
}

pub struct Fcm {
    client: reqwest::Client,
    project_id: String,
    client_email: String,
    token_uri: String,
    key: EncodingKey,
    access: Mutex<Option<(String, Instant)>>,
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: u64,
    exp: u64,
}

/// What every push carries: a data message that wakes the app, which asks its instance what to show.
pub fn message(token: &str) -> Value {
    json!({
        "message": {
            "token": token,
            "data": { "ruchoir": "wake" },
            "android": { "priority": "HIGH", "ttl": "86400s" }
        }
    })
}

/// What a push of this kind carries. A sync is a data message saying only `sync`, at normal priority
/// (nothing urgent: the phone counts its unread again and takes the read ones off its shade).
pub fn message_for(token: &str, kind: Kind) -> Value {
    match kind {
        Kind::Wake => message(token),
        Kind::Sync => json!({
            "message": {
                "token": token,
                "data": { "ruchoir": "sync" },
                "android": { "priority": "NORMAL", "ttl": "3600s" }
            }
        }),
    }
}

/// What an FCM answer means for the device. The message itself is constant and valid, so a refused
/// argument can only be the token.
pub fn outcome(status: u16, body: &Value) -> Outcome {
    let code = body["error"]["status"].as_str().unwrap_or("");
    match (status, code) {
        (200, _) => Outcome::Delivered,
        (404, _)
        | (_, "UNREGISTERED")
        | (400, "INVALID_ARGUMENT")
        | (403, "SENDER_ID_MISMATCH") => Outcome::Gone,
        _ => Outcome::Failed(format!("{status} {code}")),
    }
}

impl Fcm {
    pub fn new(account_json: &str) -> Result<Self, String> {
        let account: ServiceAccount =
            serde_json::from_str(account_json).map_err(|e| format!("FCM service account: {e}"))?;
        let key = EncodingKey::from_rsa_pem(account.private_key.as_bytes())
            .map_err(|e| format!("FCM key: {e}"))?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| format!("FCM client: {e}"))?;
        Ok(Self {
            client,
            project_id: account.project_id,
            client_email: account.client_email,
            token_uri: account
                .token_uri
                .unwrap_or_else(|| DEFAULT_TOKEN_URI.to_owned()),
            key,
            access: Mutex::new(None),
        })
    }

    async fn access_token(&self, fresh: bool) -> Result<String, String> {
        let mut cached = self.access.lock().await;
        if let Some((token, until)) = cached.as_ref() {
            if !fresh && Instant::now() < *until {
                return Ok(token.clone());
            }
        }
        let iat = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs();
        let assertion = jsonwebtoken::encode(
            &Header::new(Algorithm::RS256),
            &Claims {
                iss: &self.client_email,
                scope: SCOPE,
                aud: &self.token_uri,
                iat,
                exp: iat + 3600,
            },
            &self.key,
        )
        .map_err(|e| format!("FCM assertion: {e}"))?;
        let response: Value = self
            .client
            .post(&self.token_uri)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .send()
            .await
            .map_err(|e| format!("FCM token: {e}"))?
            .json()
            .await
            .map_err(|e| format!("FCM token: {e}"))?;
        let token = response["access_token"]
            .as_str()
            .ok_or_else(|| format!("FCM token refused: {}", response["error"]))?
            .to_owned();
        let lasts = response["expires_in"].as_u64().unwrap_or(3600);
        // Renewed five minutes before Google stops taking it.
        let until = Instant::now() + Duration::from_secs(lasts.saturating_sub(300));
        *cached = Some((token.clone(), until));
        Ok(token)
    }

    async fn send_once(&self, device: &str, kind: Kind, fresh: bool) -> (u16, Value) {
        let access = match self.access_token(fresh).await {
            Ok(access) => access,
            Err(e) => return (0, json!({ "error": { "status": e } })),
        };
        let response = self
            .client
            .post(format!(
                "https://fcm.googleapis.com/v1/projects/{}/messages:send",
                self.project_id
            ))
            .bearer_auth(access)
            .json(&message_for(device, kind))
            .send()
            .await;
        match response {
            Ok(response) => {
                let status = response.status().as_u16();
                (status, response.json().await.unwrap_or(Value::Null))
            }
            Err(e) => (0, json!({ "error": { "status": e.to_string() } })),
        }
    }
}

impl Pusher for Fcm {
    fn push<'a>(
        &'a self,
        token: &'a str,
        kind: Kind,
    ) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
        Box::pin(async move {
            let (status, body) = self.send_once(token, kind, false).await;
            if status == 401 {
                let (status, body) = self.send_once(token, kind, true).await;
                return outcome(status, &body);
            }
            outcome(status, &body)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_message_only_wakes() {
        let message = message("token");
        assert_eq!(message["message"]["data"], json!({ "ruchoir": "wake" }));
        assert_eq!(message["message"]["android"]["priority"], "HIGH");
        assert!(
            message["message"].get("notification").is_none(),
            "nothing to read"
        );
    }

    #[test]
    fn a_sync_only_says_sync() {
        let sync = message_for("tok", Kind::Sync);
        assert_eq!(sync["message"]["data"], json!({ "ruchoir": "sync" }));
        assert_eq!(sync["message"]["android"]["priority"], "NORMAL");
        assert!(sync["message"].get("notification").is_none());
        assert_eq!(message_for("tok", Kind::Wake), message("tok"));
    }

    #[test]
    fn google_answers_are_read() {
        assert_eq!(outcome(200, &json!({ "name": "x" })), Outcome::Delivered);
        assert_eq!(
            outcome(404, &json!({ "error": { "status": "NOT_FOUND" } })),
            Outcome::Gone
        );
        assert_eq!(
            outcome(400, &json!({ "error": { "status": "INVALID_ARGUMENT" } })),
            Outcome::Gone
        );
        assert!(matches!(
            outcome(503, &json!({ "error": { "status": "UNAVAILABLE" } })),
            Outcome::Failed(_)
        ));
    }

    #[test]
    fn an_account_that_is_not_one_is_refused() {
        assert!(Fcm::new("{}").is_err());
        assert!(Fcm::new(r#"{"project_id":"p","client_email":"e","private_key":"nope"}"#).is_err());
    }
}
