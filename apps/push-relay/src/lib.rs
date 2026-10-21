//! The publisher-run push relay (ADR 0006).
//!
//! A Ruchoir instance cannot hold the keys that let a server push to the published phone apps, so it
//! posts `{platform, token}` here, and the relay wakes that device through Apple (APNs) or Google
//! (FCM) with a constant payload. The phone then asks its own instance what to show. The relay keeps
//! nothing but rate-limit counters, and never logs a token.
//!
//! Two routes, two constant payloads:
//! - `/v1/send` wakes the phone to show something new (an alert its extension fills in);
//! - `/v1/sync` tells it, silently, that something was read elsewhere: it counts its unread again for
//!   the icon and takes the read notifications off the screen. Nothing is shown.

pub mod apns;
pub mod fcm;
pub mod limit;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use limit::Limiter;

/// What a vendor answered for one device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Delivered,
    /// The token is dead for good: the instance should forget the device.
    Gone,
    /// The vendor refused or could not be reached; worth trying again later.
    Failed(String),
}

/// Which constant push a device gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Something new: the phone shows it (`/v1/send`).
    Wake,
    /// Something was read elsewhere: the phone updates its count and its shade, silently (`/v1/sync`).
    Sync,
}

/// One vendor's sender.
pub trait Pusher: Send + Sync {
    fn push<'a>(
        &'a self,
        token: &'a str,
        kind: Kind,
    ) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;
}

pub struct Relay {
    pub apns: Option<Arc<dyn Pusher>>,
    pub fcm: Option<Arc<dyn Pusher>>,
    per_address: Limiter,
    per_device: Limiter,
    /// Syncs have their own allowance, so a burst of reading never holds back a new message.
    per_device_sync: Limiter,
}

impl Relay {
    pub fn new(apns: Option<Arc<dyn Pusher>>, fcm: Option<Arc<dyn Pusher>>) -> Self {
        Self {
            apns,
            fcm,
            // An instance sends for all its people; a device is woken a few times a minute at most.
            per_address: Limiter::new(1_200, Duration::from_secs(60)),
            per_device: Limiter::new(20, Duration::from_secs(60)),
            per_device_sync: Limiter::new(10, Duration::from_secs(60)),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SendRequest {
    pub platform: String,
    pub token: String,
}

/// An APNs device token: hex, as the app reports it.
fn plausible_apns(token: &str) -> bool {
    (32..=400).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// An FCM registration token: letters, digits and a little punctuation.
fn plausible_fcm(token: &str) -> bool {
    (20..=4096).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'))
}

pub fn router(relay: Arc<Relay>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/send", post(send))
        .route("/v1/sync", post(sync))
        .layer(DefaultBodyLimit::max(8 * 1024))
        .with_state(relay)
}

async fn health(State(relay): State<Arc<Relay>>) -> Json<Value> {
    Json(json!({ "status": "ok", "apns": relay.apns.is_some(), "fcm": relay.fcm.is_some() }))
}

fn answer(status: StatusCode, result: &str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "result": result })))
}

async fn send(
    State(relay): State<Arc<Relay>>,
    headers: HeaderMap,
    Json(body): Json<SendRequest>,
) -> (StatusCode, Json<Value>) {
    deliver(&relay, &headers, body, Kind::Wake).await
}

async fn sync(
    State(relay): State<Arc<Relay>>,
    headers: HeaderMap,
    Json(body): Json<SendRequest>,
) -> (StatusCode, Json<Value>) {
    deliver(&relay, &headers, body, Kind::Sync).await
}

async fn deliver(
    relay: &Relay,
    headers: &HeaderMap,
    body: SendRequest,
    kind: Kind,
) -> (StatusCode, Json<Value>) {
    let (pusher, plausible) = match body.platform.as_str() {
        "ios" => (relay.apns.clone(), plausible_apns(&body.token)),
        "android" => (relay.fcm.clone(), plausible_fcm(&body.token)),
        _ => return answer(StatusCode::BAD_REQUEST, "unknown_platform"),
    };
    if !plausible {
        return answer(StatusCode::BAD_REQUEST, "invalid_token");
    }
    // nginx, in front, names the caller; the relay itself listens on the loopback only.
    let address = headers
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown");
    let now = Instant::now();
    let per_device = match kind {
        Kind::Wake => &relay.per_device,
        Kind::Sync => &relay.per_device_sync,
    };
    if !relay.per_address.allow(address, now) || !per_device.allow(&body.token, now) {
        return answer(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let Some(pusher) = pusher else {
        return answer(StatusCode::SERVICE_UNAVAILABLE, "not_configured");
    };
    match pusher.push(&body.token, kind).await {
        Outcome::Delivered => answer(StatusCode::ACCEPTED, "delivered"),
        Outcome::Gone => answer(StatusCode::GONE, "gone"),
        Outcome::Failed(reason) => {
            tracing::warn!(platform = %body.platform, ?kind, %reason, "push refused");
            answer(StatusCode::BAD_GATEWAY, "failed")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use std::sync::Mutex;
    use tower::ServiceExt;

    /// A pusher that records the tokens it was given and answers what it is told.
    struct Fake {
        outcome: Outcome,
        seen: Mutex<Vec<String>>,
        kinds: Mutex<Vec<Kind>>,
    }

    impl Pusher for Fake {
        fn push<'a>(
            &'a self,
            token: &'a str,
            kind: Kind,
        ) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
            self.seen.lock().unwrap().push(token.to_owned());
            self.kinds.lock().unwrap().push(kind);
            let outcome = self.outcome.clone();
            Box::pin(async move { outcome })
        }
    }

    fn fake(outcome: Outcome) -> Arc<Fake> {
        Arc::new(Fake {
            outcome,
            seen: Mutex::new(Vec::new()),
            kinds: Mutex::new(Vec::new()),
        })
    }

    const IOS_TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const ANDROID_TOKEN: &str = "dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8";

    async fn post(relay: Arc<Relay>, body: Value) -> (StatusCode, Value) {
        post_to(relay, "/v1/send", body).await
    }

    async fn post_to(relay: Arc<Relay>, path: &str, body: Value) -> (StatusCode, Value) {
        let response = router(relay)
            .oneshot(
                Request::post(path)
                    .header("content-type", "application/json")
                    .header("x-real-ip", "203.0.113.7")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn a_device_is_woken_through_its_platform() {
        let apple = fake(Outcome::Delivered);
        let google = fake(Outcome::Delivered);
        let relay = Arc::new(Relay::new(Some(apple.clone()), Some(google.clone())));
        let (status, body) = post(
            relay.clone(),
            json!({ "platform": "ios", "token": IOS_TOKEN }),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(body["result"], "delivered");
        let (status, _) = post(
            relay,
            json!({ "platform": "android", "token": ANDROID_TOKEN }),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(*apple.seen.lock().unwrap(), vec![IOS_TOKEN.to_owned()]);
        assert_eq!(*google.seen.lock().unwrap(), vec![ANDROID_TOKEN.to_owned()]);
    }

    #[tokio::test]
    async fn a_dead_token_is_reported_gone() {
        let relay = Arc::new(Relay::new(Some(fake(Outcome::Gone)), None));
        let (status, body) = post(relay, json!({ "platform": "ios", "token": IOS_TOKEN })).await;
        assert_eq!(status, StatusCode::GONE);
        assert_eq!(body["result"], "gone");
    }

    #[tokio::test]
    async fn a_platform_without_its_key_says_so() {
        let relay = Arc::new(Relay::new(None, None));
        let (status, body) = post(
            relay,
            json!({ "platform": "android", "token": ANDROID_TOKEN }),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["result"], "not_configured");
    }

    #[tokio::test]
    async fn malformed_requests_reach_no_vendor() {
        let apple = fake(Outcome::Delivered);
        let relay = Arc::new(Relay::new(Some(apple.clone()), None));
        let (status, _) = post(
            relay.clone(),
            json!({ "platform": "windows", "token": IOS_TOKEN }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, body) = post(
            relay,
            json!({ "platform": "ios", "token": "not hex at all" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["result"], "invalid_token");
        assert!(apple.seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn one_device_cannot_be_woken_without_end() {
        let relay = Arc::new(Relay::new(Some(fake(Outcome::Delivered)), None));
        for _ in 0..20 {
            let (status, _) = post(
                relay.clone(),
                json!({ "platform": "ios", "token": IOS_TOKEN }),
            )
            .await;
            assert_eq!(status, StatusCode::ACCEPTED);
        }
        let (status, body) = post(relay, json!({ "platform": "ios", "token": IOS_TOKEN })).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body["result"], "rate_limited");
    }

    #[tokio::test]
    async fn a_device_is_synced_silently_through_its_platform() {
        let apple = fake(Outcome::Delivered);
        let google = fake(Outcome::Delivered);
        let relay = Arc::new(Relay::new(Some(apple.clone()), Some(google.clone())));
        let (status, body) = post_to(
            relay.clone(),
            "/v1/sync",
            json!({ "platform": "ios", "token": IOS_TOKEN }),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(body["result"], "delivered");
        let (status, _) = post_to(
            relay.clone(),
            "/v1/sync",
            json!({ "platform": "android", "token": ANDROID_TOKEN }),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let (status, _) = post(relay, json!({ "platform": "ios", "token": IOS_TOKEN })).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(*apple.kinds.lock().unwrap(), vec![Kind::Sync, Kind::Wake]);
        assert_eq!(*google.kinds.lock().unwrap(), vec![Kind::Sync]);
    }

    #[tokio::test]
    async fn a_sync_checks_its_request_like_a_wake() {
        let apple = fake(Outcome::Gone);
        let relay = Arc::new(Relay::new(Some(apple.clone()), None));
        let (status, body) = post_to(
            relay.clone(),
            "/v1/sync",
            json!({ "platform": "ios", "token": "not hex at all" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["result"], "invalid_token");
        let (status, body) = post_to(
            relay.clone(),
            "/v1/sync",
            json!({ "platform": "android", "token": ANDROID_TOKEN }),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["result"], "not_configured");
        let (status, body) = post_to(
            relay,
            "/v1/sync",
            json!({ "platform": "ios", "token": IOS_TOKEN }),
        )
        .await;
        assert_eq!(status, StatusCode::GONE);
        assert_eq!(body["result"], "gone");
        assert_eq!(apple.seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn syncs_never_use_up_a_devices_wakes() {
        let relay = Arc::new(Relay::new(Some(fake(Outcome::Delivered)), None));
        for _ in 0..10 {
            let (status, _) = post_to(
                relay.clone(),
                "/v1/sync",
                json!({ "platform": "ios", "token": IOS_TOKEN }),
            )
            .await;
            assert_eq!(status, StatusCode::ACCEPTED);
        }
        let (status, body) = post_to(
            relay.clone(),
            "/v1/sync",
            json!({ "platform": "ios", "token": IOS_TOKEN }),
        )
        .await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body["result"], "rate_limited");
        // A new message still reaches the phone.
        let (status, _) = post(relay, json!({ "platform": "ios", "token": IOS_TOKEN })).await;
        assert_eq!(status, StatusCode::ACCEPTED);
    }
}
