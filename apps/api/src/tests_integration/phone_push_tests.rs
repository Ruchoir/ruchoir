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

/// A stand-in relay: records what it is asked, and answers `410` for a token starting with `dead`.
async fn fake_relay() -> (String, Arc<Mutex<Vec<Value>>>) {
    let seen: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let app = axum::Router::new()
        .route(
            "/v1/send",
            post(
                |AxState(seen): AxState<Arc<Mutex<Vec<Value>>>>,
                 axum::Json(body): axum::Json<Value>| async move {
                    let gone = body["token"]
                        .as_str()
                        .is_some_and(|t| t.starts_with("dead"));
                    seen.lock().unwrap().push(body);
                    if gone {
                        AxStatus::GONE
                    } else {
                        AxStatus::ACCEPTED
                    }
                },
            ),
        )
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}"), seen)
}

async fn boot_with_relay() -> Option<(TestApp, Arc<Mutex<Vec<Value>>>)> {
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
