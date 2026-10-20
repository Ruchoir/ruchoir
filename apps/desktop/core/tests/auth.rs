//! The sign-in exchange against a stand-in instance.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use ruchoir_desktop_core::auth::{begin, code_from_deep_link, complete, exchange, sign_in_url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// A server answering the exchange, counting its calls and recording what it was sent.
async fn stand_in() -> (
    String,
    Arc<AtomicUsize>,
    Arc<std::sync::Mutex<Option<(Value, bool)>>>,
) {
    let hits = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(std::sync::Mutex::new(None));
    let (h, s) = (hits.clone(), seen.clone());
    let app = Router::new().route(
        "/api/v1/auth/native/exchange",
        post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let (h, s) = (h.clone(), s.clone());
            async move {
                h.fetch_add(1, Ordering::SeqCst);
                *s.lock().unwrap() = Some((body, headers.contains_key("origin")));
                Json(json!({"id": "u1", "display_name": "Alice", "session_token": "t-123"}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), hits, seen)
}

#[test]
fn challenge_is_sha256_hex_of_verifier() {
    let pending = begin("i1");
    assert_eq!(pending.challenge.len(), 64);
    assert!(pending
        .challenge
        .bytes()
        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    let expected: String = Sha256::digest(pending.verifier().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(pending.challenge, expected);
    assert_eq!(pending.verifier().len(), 64);
}

#[test]
fn sign_in_url_names_the_challenge() {
    let pending = begin("i1");
    assert_eq!(
        sign_in_url("https://a.example", &pending),
        format!("https://a.example/n/?c={}", pending.challenge)
    );
}

#[test]
fn deep_link_parsing() {
    assert_eq!(
        code_from_deep_link("ruchoir://auth?code=abc").as_deref(),
        Some("abc")
    );
    assert_eq!(
        code_from_deep_link("ruchoir://auth/?code=abc").as_deref(),
        Some("abc")
    );
    assert_eq!(code_from_deep_link("ruchoir://passkey"), None);
    assert_eq!(code_from_deep_link("ruchoir://auth"), None);
    assert_eq!(code_from_deep_link("https://auth?code=abc"), None);
    assert_eq!(code_from_deep_link("not a url"), None);
}

#[tokio::test]
async fn exchange_posts_code_and_verifier_without_origin() {
    let (origin, hits, seen) = stand_in().await;
    let pending = begin("i1");
    let token = exchange(&reqwest::Client::new(), &origin, "c-1", &pending)
        .await
        .unwrap();
    assert_eq!(token, "t-123");
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    let (body, had_origin) = seen.lock().unwrap().clone().unwrap();
    assert_eq!(body, json!({"code": "c-1", "verifier": pending.verifier()}));
    assert!(!had_origin);
}

#[tokio::test]
async fn deep_link_without_pending_is_ignored() {
    let (origin, hits, _) = stand_in().await;
    let http = reqwest::Client::new();
    assert!(complete(&http, None, &origin, "ruchoir://auth?code=c-1")
        .await
        .is_none());
    // A link that is not a sign-in is ignored even with a sign-in pending.
    let pending = begin("i1");
    assert!(
        complete(&http, Some(&pending), &origin, "ruchoir://passkey")
            .await
            .is_none()
    );
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn an_expired_sign_in_is_ignored() {
    let (origin, hits, _) = stand_in().await;
    let mut pending = begin("i1");
    pending.started -= std::time::Duration::from_secs(11 * 60);
    let http = reqwest::Client::new();
    assert!(
        complete(&http, Some(&pending), &origin, "ruchoir://auth?code=c-1")
            .await
            .is_none()
    );
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}
