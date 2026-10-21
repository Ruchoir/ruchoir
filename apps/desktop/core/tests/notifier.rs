//! The notifier's rules.

use axum::routing::get;
use axum::{Json, Router};
use ruchoir_desktop_core::notifier::{
    advance, fetch_pending, fresh, in_quiet_hours, should_draw, target_path, NotifySettings,
    PendingItem,
};
use ruchoir_desktop_core::summary::SpaceSummary;
use serde_json::json;

fn settings(quiet: bool, from: &str, to: &str) -> NotifySettings {
    NotifySettings {
        enabled: true,
        sound: true,
        quiet_hours: quiet,
        quiet_from: from.into(),
        quiet_to: to.into(),
    }
}

const fn at(h: u32, m: u32) -> u32 {
    h * 60 + m
}

fn item(id: &str, created_at: &str) -> PendingItem {
    PendingItem {
        id: id.into(),
        kind: "mention".into(),
        space_id: Some("s1".into()),
        conversation_id: Some("c1".into()),
        message_id: Some("m1".into()),
        event_id: None,
        title: "Alice".into(),
        body: "hello".into(),
        channel_name: Some("general".into()),
        created_at: created_at.into(),
    }
}

fn spaces() -> Vec<SpaceSummary> {
    vec![SpaceSummary {
        id: "s1".into(),
        slug: "studio".into(),
        name: "Studio".into(),
        icon_url: None,
        unread: 0,
        mentions: 0,
    }]
}

#[test]
fn quiet_hours_cross_midnight() {
    let night = settings(true, "21:00", "08:00");
    assert!(in_quiet_hours(&night, at(23, 30)));
    assert!(in_quiet_hours(&night, at(7, 59)));
    assert!(!in_quiet_hours(&night, at(8, 0)));
    assert!(!in_quiet_hours(&night, at(20, 59)));
    let day = settings(true, "09:00", "17:00");
    assert!(in_quiet_hours(&day, at(12, 0)));
    assert!(!in_quiet_hours(&day, at(17, 0)));
    assert!(!in_quiet_hours(
        &settings(false, "00:00", "23:59"),
        at(12, 0)
    ));
}

#[test]
fn disabled_draws_nothing() {
    let mut s = settings(false, "21:00", "08:00");
    s.enabled = false;
    assert!(!should_draw(&s, at(12, 0), false));
}

#[test]
fn on_screen_draws_nothing() {
    let s = settings(false, "21:00", "08:00");
    assert!(!should_draw(&s, at(12, 0), true));
    assert!(should_draw(&s, at(12, 0), false));
}

#[test]
fn items_at_or_before_since_are_dropped() {
    let items = vec![
        item("3", "2026-10-21T10:00:03Z"),
        item("2", "2026-10-21T10:00:02Z"),
        item("1", "2026-10-21T10:00:01Z"),
    ];
    let kept = fresh(&items, Some("2026-10-21T12:00:02+02:00"));
    assert_eq!(
        kept.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        ["3"]
    );
    let all = fresh(&items, None);
    assert_eq!(
        all.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        ["1", "2", "3"]
    );
}

#[test]
fn since_never_goes_back() {
    let drawn = vec![item("1", "2026-10-21T10:00:01Z")];
    assert_eq!(
        advance(Some("2026-10-21T10:00:05Z"), &drawn).as_deref(),
        Some("2026-10-21T10:00:05Z")
    );
    assert_eq!(
        advance(None, &drawn).as_deref(),
        Some("2026-10-21T10:00:01Z")
    );
    assert_eq!(
        advance(Some("2026-10-21T10:00:00Z"), &drawn).as_deref(),
        Some("2026-10-21T10:00:01Z")
    );
    assert_eq!(advance(None, &[]), None);
}

#[test]
fn channel_message_opens_its_channel() {
    assert_eq!(
        target_path(&item("1", "2026-10-21T10:00:01Z"), &spaces()),
        "/e/studio/c/general"
    );
    let mut dm = item("2", "2026-10-21T10:00:01Z");
    dm.channel_name = None;
    assert_eq!(target_path(&dm, &spaces()), "/e/studio");
}

#[test]
fn unknown_space_opens_the_instance() {
    let mut elsewhere = item("1", "2026-10-21T10:00:01Z");
    elsewhere.space_id = Some("s9".into());
    assert_eq!(target_path(&elsewhere, &spaces()), "/");
    elsewhere.space_id = None;
    assert_eq!(target_path(&elsewhere, &spaces()), "/");
}

#[tokio::test]
async fn pending_parses_the_api_shape() {
    let app = Router::new().route(
        "/api/v1/push/pending",
        get(|| async {
            Json(json!({"silent": true, "items": [{
                "id": "n1", "kind": "mention", "space_id": "s1", "conversation_id": "c1",
                "message_id": "m1", "title": "Alice in #general", "body": "hello",
                "channel_name": "general", "actor_name": "Alice", "created_at": "2026-10-21T10:00:01Z"
            }]}))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let pending = fetch_pending(
        &reqwest::Client::new(),
        &format!("http://{addr}"),
        "t",
        None,
    )
    .await
    .unwrap();
    assert!(pending.silent);
    assert_eq!(pending.items.len(), 1);
    assert_eq!(pending.items[0].title, "Alice in #general");
    assert_eq!(pending.items[0].event_id, None);
}
