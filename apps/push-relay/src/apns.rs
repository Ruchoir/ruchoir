//! Apple's push service (APNs), with the token-based provider authentication: a JWT signed (ES256)
//! with the team's `.p8` key, valid an hour, reused for forty minutes.

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::{Outcome, Pusher};

/// Production APNs: every Ruchoir build is signed for the App Store (TestFlight included).
pub const PRODUCTION_HOST: &str = "api.push.apple.com";
const TOKEN_REUSE: Duration = Duration::from_secs(40 * 60);

pub struct Apns {
    client: reqwest::Client,
    host: String,
    topic: String,
    key_id: String,
    team_id: String,
    key: EncodingKey,
    token: Mutex<Option<(String, Instant)>>,
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    iat: u64,
}

/// What every push carries: an alert the phone's Notification Service Extension replaces with what
/// the instance says (`mutable-content`), and nothing else. Never any content (ADR 0006).
pub fn payload() -> Value {
    json!({
        "aps": {
            "alert": { "title": "Ruchoir", "body": "…" },
            "mutable-content": 1,
            "sound": "default"
        }
    })
}

/// What an APNs answer means for the device.
pub fn outcome(status: u16, reason: Option<&str>) -> Outcome {
    match (status, reason) {
        (200, _) => Outcome::Delivered,
        (410, _) => Outcome::Gone,
        (400, Some("BadDeviceToken" | "DeviceTokenNotForTopic")) => Outcome::Gone,
        (_, reason) => Outcome::Failed(format!("{status} {}", reason.unwrap_or(""))),
    }
}

impl Apns {
    pub fn new(
        pem: &str,
        key_id: &str,
        team_id: &str,
        topic: &str,
        host: &str,
    ) -> Result<Self, String> {
        let key = EncodingKey::from_ec_pem(pem.as_bytes()).map_err(|e| format!("APNs key: {e}"))?;
        let client = reqwest::Client::builder()
            .http2_prior_knowledge()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| format!("APNs client: {e}"))?;
        Ok(Self {
            client,
            host: host.to_owned(),
            topic: topic.to_owned(),
            key_id: key_id.to_owned(),
            team_id: team_id.to_owned(),
            key,
            token: Mutex::new(None),
        })
    }

    async fn bearer(&self, fresh: bool) -> Result<String, String> {
        let mut cached = self.token.lock().await;
        if let Some((token, made)) = cached.as_ref() {
            if !fresh && made.elapsed() < TOKEN_REUSE {
                return Ok(token.clone());
            }
        }
        let iat = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs();
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(self.key_id.clone());
        let token = jsonwebtoken::encode(
            &header,
            &Claims {
                iss: &self.team_id,
                iat,
            },
            &self.key,
        )
        .map_err(|e| format!("APNs token: {e}"))?;
        *cached = Some((token.clone(), Instant::now()));
        Ok(token)
    }

    async fn send_once(&self, device: &str, fresh: bool) -> (u16, Option<String>) {
        let bearer = match self.bearer(fresh).await {
            Ok(bearer) => bearer,
            Err(e) => return (0, Some(e)),
        };
        let expiration = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() + 86_400)
            .unwrap_or(0);
        let response = self
            .client
            .post(format!("https://{}/3/device/{device}", self.host))
            .header("authorization", format!("bearer {bearer}"))
            .header("apns-topic", &self.topic)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .header("apns-expiration", expiration.to_string())
            .json(&payload())
            .send()
            .await;
        match response {
            Ok(response) => {
                let status = response.status().as_u16();
                let reason = response
                    .json::<Value>()
                    .await
                    .ok()
                    .and_then(|v| v["reason"].as_str().map(str::to_owned));
                (status, reason)
            }
            Err(e) => (0, Some(e.to_string())),
        }
    }
}

impl Pusher for Apns {
    fn push<'a>(&'a self, token: &'a str) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
        Box::pin(async move {
            let (status, reason) = self.send_once(token, false).await;
            // A provider token Apple no longer takes: make a new one and try once more.
            if status == 403 && reason.as_deref() == Some("ExpiredProviderToken") {
                let (status, reason) = self.send_once(token, true).await;
                return outcome(status, reason.as_deref());
            }
            outcome(status, reason.as_deref())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_payload_carries_nothing_but_a_placeholder() {
        let payload = payload();
        assert_eq!(payload["aps"]["mutable-content"], 1);
        assert_eq!(payload["aps"]["alert"]["title"], "Ruchoir");
        assert_eq!(
            payload.as_object().unwrap().len(),
            1,
            "nothing beside `aps`"
        );
    }

    #[test]
    fn apple_answers_are_read() {
        assert_eq!(outcome(200, None), Outcome::Delivered);
        assert_eq!(outcome(410, Some("Unregistered")), Outcome::Gone);
        assert_eq!(outcome(400, Some("BadDeviceToken")), Outcome::Gone);
        assert!(matches!(
            outcome(429, Some("TooManyRequests")),
            Outcome::Failed(_)
        ));
        assert!(matches!(outcome(0, Some("timeout")), Outcome::Failed(_)));
    }

    #[test]
    fn a_key_that_is_not_one_is_refused() {
        assert!(Apns::new(
            "not a key",
            "KEY",
            "TEAM",
            "com.ruchoir.app",
            PRODUCTION_HOST
        )
        .is_err());
    }
}
