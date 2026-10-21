//! Summaries against a stand-in instance.

use std::time::{Duration, Instant};

use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use ruchoir_desktop_core::summary::{fetch_summary, wants_refresh, Debounce, FetchError};
use serde_json::json;

async fn serve(token: &'static str) -> String {
    let authorised = move |headers: &HeaderMap| {
        headers.get("authorization").and_then(|v| v.to_str().ok())
            == Some(&format!("Bearer {token}"))
    };
    let app = Router::new()
        .route(
            "/api/v1/me/spaces",
            get(move |headers: HeaderMap| async move {
                if !authorised(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                Json(json!([
                    {"id": "s1", "slug": "studio", "name": "Studio", "unread": 3, "mentions": 1, "members": 4, "role": "member", "notify_level": "default"},
                    {"id": "s2", "slug": "compta", "name": "Compta", "icon_url": "/api/v1/spaces/s2/icon", "unread": 0, "mentions": 0, "members": 2, "role": "owner", "notify_level": "default"}
                ]))
                .into_response()
            }),
        )
        .route(
            "/api/v1/notifications",
            get(move |headers: HeaderMap| async move {
                if !authorised(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                Json(json!({"notifications": [], "next_before": null, "unread_count": 5})).into_response()
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

#[tokio::test]
async fn parses_spaces_and_unread_count() {
    let origin = serve("t").await;
    let summary = fetch_summary(&reqwest::Client::new(), &origin, "t")
        .await
        .unwrap();
    assert_eq!(summary.unread_notifications, 5);
    assert_eq!(summary.spaces.len(), 2);
    assert_eq!(summary.spaces[0].slug, "studio");
    assert_eq!(summary.spaces[0].unread, 3);
    assert_eq!(summary.spaces[0].mentions, 1);
    assert_eq!(summary.spaces[0].icon_url, None);
    assert_eq!(
        summary.spaces[1].icon_url.as_deref(),
        Some("/api/v1/spaces/s2/icon")
    );
}

#[tokio::test]
async fn a_401_is_unauthorized() {
    let origin = serve("right").await;
    let error = fetch_summary(&reqwest::Client::new(), &origin, "wrong")
        .await
        .unwrap_err();
    assert_eq!(error, FetchError::Unauthorized);
}

#[tokio::test]
async fn a_closed_port_is_unreachable() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let error = fetch_summary(
        &reqwest::Client::new(),
        &format!("http://127.0.0.1:{port}"),
        "t",
    )
    .await
    .unwrap_err();
    assert_eq!(error, FetchError::Unreachable);
}

#[test]
fn refresh_on_messages_reads_and_space_changes_only() {
    for kind in [
        "message.created",
        "message.deleted",
        "read.updated",
        "notification.created",
        "space.removed",
        "member.joined",
        "channel.created",
    ] {
        assert!(wants_refresh(kind), "{kind}");
    }
    for kind in ["typing", "presence", "reaction.added", "message.updated"] {
        assert!(!wants_refresh(kind), "{kind}");
    }
}

#[test]
fn debounce_lets_one_through_per_window() {
    let mut debounce = Debounce::default();
    let start = Instant::now();
    assert!(debounce.hit(start));
    assert!(!debounce.hit(start + Duration::from_millis(500)));
    assert!(!debounce.hit(start + Duration::from_millis(1999)));
    assert!(debounce.hit(start + Duration::from_millis(2000)));
}
