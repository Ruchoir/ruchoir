//! End-to-end tests for phone notifications (ADR 0006): the phones an account registers, and the
//! relay being asked to wake them. Same harness as the parent module, same skip rule; the relay is
//! a stand-in started here, never the publisher's.

use super::*;

use std::sync::Mutex;

use axum::extract::State as AxState;
use axum::http::StatusCode as AxStatus;
use axum::routing::post;

use crate::entities::push_devices;

/// A phone token as Apple writes them.
fn ios_token() -> String {
    format!("{:064x}", Uuid::new_v4().as_u128())
}

type Seen = Arc<Mutex<Vec<Value>>>;

/// What the stand-in relay was asked: wakes on `/v1/send`, silent syncs on `/v1/sync`.
#[derive(Clone, Default)]
struct Asked {
    woken: Seen,
    synced: Seen,
}

/// Record a call, and answer `410` for a token starting with `dead`.
fn record(list: &Seen, body: Value) -> AxStatus {
    let gone = body["token"]
        .as_str()
        .is_some_and(|t| t.starts_with("dead"));
    list.lock().unwrap().push(body);
    if gone {
        AxStatus::GONE
    } else {
        AxStatus::ACCEPTED
    }
}

/// A stand-in relay: records what it is asked, and answers `410` for a token starting with `dead`.
async fn fake_relay() -> (String, Seen) {
    let (url, asked) = fake_relay_both().await;
    (url, asked.woken)
}

/// The same stand-in, with what it was asked on both routes.
async fn fake_relay_both() -> (String, Asked) {
    let asked = Asked::default();
    let app = axum::Router::new()
        .route(
            "/v1/send",
            post(
                |AxState(asked): AxState<Asked>, axum::Json(body): axum::Json<Value>| async move {
                    record(&asked.woken, body)
                },
            ),
        )
        .route(
            "/v1/sync",
            post(
                |AxState(asked): AxState<Asked>, axum::Json(body): axum::Json<Value>| async move {
                    record(&asked.synced, body)
                },
            ),
        )
        .with_state(asked.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}"), asked)
}

async fn boot_with_relay() -> Option<(TestApp, Seen)> {
    let (url, seen) = fake_relay().await;
    let app = boot_with(None, |config| config.push_relay_url = Some(url)).await?;
    Some((app, seen))
}

async fn register(app: &TestApp, cookie: &str, platform: &str, token: &str) -> u16 {
    app.req(reqwest::Method::PUT, "/api/v1/push/devices", cookie)
        .json(&json!({ "platform": platform, "token": token }))
        .send()
        .await
        .expect("register")
        .status()
        .as_u16()
}

async fn devices_of(app: &TestApp, user: Uuid) -> Vec<push_devices::Model> {
    push_devices::Entity::find()
        .filter(push_devices::Column::UserId.eq(user))
        .all(&app.db)
        .await
        .expect("query")
}

#[tokio::test]
async fn a_phone_is_remembered_once_and_moves_with_whoever_signs_in() {
    let Some((app, _)) = boot_with_relay().await else {
        return;
    };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let token = ios_token();

    assert_eq!(register(&app, &alice, "ios", &token).await, 204);
    assert_eq!(
        register(&app, &alice, "ios", &token).await,
        204,
        "again: refreshed, not doubled"
    );
    assert_eq!(devices_of(&app, fx.alice).await.len(), 1);

    // The same phone, now signed in as Bob, wakes Bob alone.
    assert_eq!(register(&app, &bob, "ios", &token).await, 204);
    assert!(devices_of(&app, fx.alice).await.is_empty());
    assert_eq!(devices_of(&app, fx.bob).await.len(), 1);

    // Alice cannot forget Bob's phone; Bob can.
    for (cookie, remaining) in [(&alice, 1), (&bob, 0)] {
        let forgotten = app
            .req(reqwest::Method::DELETE, "/api/v1/push/devices", cookie)
            .json(&json!({ "token": token }))
            .send()
            .await
            .expect("delete");
        assert_eq!(forgotten.status(), 204);
        assert_eq!(devices_of(&app, fx.bob).await.len(), remaining);
    }
}

#[tokio::test]
async fn only_a_device_token_is_taken() {
    let Some((app, _)) = boot_with_relay().await else {
        return;
    };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    assert_eq!(register(&app, &alice, "ios", "not a token").await, 400);
    assert_eq!(register(&app, &alice, "windows", &ios_token()).await, 400);
    assert!(devices_of(&app, fx.alice).await.is_empty());
}

#[tokio::test]
async fn phones_are_off_without_a_relay() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    assert_eq!(register(&app, &alice, "ios", &ios_token()).await, 409);
}

#[tokio::test]
async fn signing_out_everywhere_forgets_the_phones() {
    let Some((app, _)) = boot_with_relay().await else {
        return;
    };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    assert_eq!(register(&app, &alice, "ios", &ios_token()).await, 204);
    let out = app
        .req(reqwest::Method::POST, "/api/v1/auth/logout/all", &alice)
        .send()
        .await
        .expect("logout all");
    assert_eq!(out.status(), 204);
    assert!(devices_of(&app, fx.alice).await.is_empty());
}

#[tokio::test]
async fn a_mention_wakes_the_phone_through_the_relay_and_a_dead_one_is_forgotten() {
    let Some((app, seen)) = boot_with_relay().await else {
        return;
    };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let live = ios_token();
    let dead = format!("dead{}", &ios_token()[4..]);
    assert_eq!(register(&app, &alice, "ios", &live).await, 204);
    assert_eq!(register(&app, &alice, "ios", &dead).await, 204);

    mention_alice(&app, &fx).await;

    // Sent in the background, after the message's transaction: wait for both.
    for _ in 0..50 {
        if seen.lock().unwrap().len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let asked = seen.lock().unwrap().clone();
    assert_eq!(asked.len(), 2, "one call per phone: {asked:?}");
    for body in &asked {
        assert_eq!(body["platform"], "ios");
        assert_eq!(
            body.as_object().map(|o| o.len()),
            Some(2),
            "the relay learns the platform and the token, nothing else"
        );
    }
    // The relay said the dead one is gone: the instance forgot it.
    for _ in 0..50 {
        if devices_of(&app, fx.alice).await.len() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let left = devices_of(&app, fx.alice).await;
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].token, live);
}

#[tokio::test]
async fn a_test_wakes_each_phone_and_is_handed_out_once() {
    let Some((app, seen)) = boot_with_relay().await else {
        return;
    };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let test = |cookie: String| {
        let app = &app;
        async move {
            app.req(reqwest::Method::POST, "/api/v1/push/devices/test", &cookie)
                .send()
                .await
                .expect("test")
        }
    };

    // No phone yet: nothing to wake.
    assert_eq!(test(alice.clone()).await.status(), 409);

    assert_eq!(register(&app, &alice, "ios", &ios_token()).await, 204);
    let sent = test(alice.clone()).await;
    assert_eq!(sent.status(), 200);
    assert_eq!(sent.json::<Value>().await.expect("json")["devices"], 1);
    assert_eq!(seen.lock().unwrap().len(), 1, "the relay was asked once");
    // Right after, the shared throttle holds a second one back.
    assert_eq!(test(alice.clone()).await.status(), 409);

    // The phone, woken, asks what to show: the test, once.
    let pending = |cookie: String| {
        let app = &app;
        async move {
            app.req(reqwest::Method::GET, "/api/v1/push/pending", &cookie)
                .send()
                .await
                .expect("pending")
                .json::<Value>()
                .await
                .expect("json")
        }
    };
    let first = pending(alice.clone()).await;
    let second = pending(alice.clone()).await;
    assert_ne!(
        first, second,
        "the test is collected once: {first} / {second}"
    );
}

// --- Read everywhere: a notification read on one device is read on the others ---

async fn boot_with_both() -> Option<(TestApp, Asked)> {
    let (url, asked) = fake_relay_both().await;
    let app = boot_with(None, |config| config.push_relay_url = Some(url)).await?;
    Some((app, asked))
}

/// Wait until `list` holds `count` calls, then a little more, so a call too many would show.
async fn settle(list: &Seen, count: usize) -> Vec<Value> {
    for _ in 0..80 {
        if list.lock().unwrap().len() >= count {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    list.lock().unwrap().clone()
}

async fn put(app: &TestApp, cookie: &str, path: &str) -> u16 {
    app.req(reqwest::Method::PUT, path, cookie)
        .send()
        .await
        .expect("put")
        .status()
        .as_u16()
}

/// Wait for the next `notification.read` event, or none within a few seconds.
async fn next_read(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) -> Option<Value> {
    next_event_of(ws, "notification.read").await
}

#[tokio::test]
async fn reading_one_notification_tells_every_open_device() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let first = mention_alice(&app, &fx).await;
    let mut alices = app.connect_ws(&alice).await;
    let mut bobs = app.connect_ws(&bob).await;

    assert_eq!(
        put(
            &app,
            &alice,
            &format!("/api/v1/notifications/{}/read", first.id)
        )
        .await,
        204
    );
    let event = next_read(&mut alices)
        .await
        .expect("Alice's other devices hear it");
    assert_eq!(event["payload"]["ids"], json!([first.id]));
    assert_eq!(event["payload"]["all"], false);
    assert_eq!(event["payload"]["unread_count"], 0);

    // Read again: nothing changed, nothing said.
    assert_eq!(
        put(
            &app,
            &alice,
            &format!("/api/v1/notifications/{}/read", first.id)
        )
        .await,
        204
    );
    assert!(
        next_read(&mut alices).await.is_none(),
        "no event for a no-op"
    );
    // Nobody else hears about Alice's notifications.
    assert!(next_read(&mut bobs).await.is_none());
}

#[tokio::test]
async fn reading_all_tells_every_open_device_with_the_count_left() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    mention_alice(&app, &fx).await;
    mention_alice(&app, &fx).await;
    let mut ws = app.connect_ws(&alice).await;

    assert_eq!(put(&app, &alice, "/api/v1/notifications/read").await, 204);
    let event = next_read(&mut ws).await.expect("an event");
    assert_eq!(event["payload"]["all"], true);
    assert_eq!(event["payload"]["ids"], json!([]));
    assert_eq!(event["payload"]["unread_count"], 0);

    // Nothing left unread: a second "read all" says nothing.
    assert_eq!(put(&app, &alice, "/api/v1/notifications/read").await, 204);
    assert!(next_read(&mut ws).await.is_none());
}

#[tokio::test]
async fn a_read_elsewhere_syncs_the_phones_silently_once_per_burst() {
    let Some((app, asked)) = boot_with_both().await else {
        return;
    };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let token = ios_token();
    assert_eq!(register(&app, &alice, "ios", &token).await, 204);
    let first = mention_alice(&app, &fx).await;
    let woken = settle(&asked.woken, 1).await.len();
    assert_eq!(woken, 1, "the mention woke the phone");

    // Read one, then all, in quick succession: one silent sync, after the burst.
    assert_eq!(
        put(
            &app,
            &alice,
            &format!("/api/v1/notifications/{}/read", first.id)
        )
        .await,
        204
    );
    mention_alice(&app, &fx).await;
    assert_eq!(put(&app, &alice, "/api/v1/notifications/read").await, 204);
    let synced = settle(&asked.synced, 1).await;
    assert_eq!(synced.len(), 1, "one sync for the burst: {synced:?}");
    assert_eq!(synced[0], json!({ "platform": "ios", "token": token }));
    assert_eq!(
        asked.woken.lock().unwrap().len(),
        2,
        "a read never wakes the phone with an alert"
    );
}

#[tokio::test]
async fn nothing_read_nothing_synced() {
    let Some((app, asked)) = boot_with_both().await else {
        return;
    };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    assert_eq!(register(&app, &alice, "ios", &ios_token()).await, 204);
    assert_eq!(put(&app, &alice, "/api/v1/notifications/read").await, 204);
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert!(asked.synced.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_phone_gone_when_synced_is_forgotten() {
    let Some((app, asked)) = boot_with_both().await else {
        return;
    };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let dead = format!("dead{}", &ios_token()[4..]);
    let first = mention_alice(&app, &fx).await;
    assert_eq!(register(&app, &alice, "ios", &dead).await, 204);
    assert_eq!(
        put(
            &app,
            &alice,
            &format!("/api/v1/notifications/{}/read", first.id)
        )
        .await,
        204
    );
    settle(&asked.synced, 1).await;
    for _ in 0..50 {
        if devices_of(&app, fx.alice).await.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(devices_of(&app, fx.alice).await.is_empty());
}
