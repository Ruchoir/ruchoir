//! End-to-end tests for the messaging and real-time surface.
//!
//! These boot the real router against a throwaway PostgreSQL and a Valkey instance, so they run
//! only when `RUCHOIR_TEST_DATABASE_URL` is set (and a Valkey is reachable at `VALKEY_TEST_URL`,
//! defaulting to the dev instance). Without those they are a no-op, keeping `cargo test` green in a
//! bare CI. To run locally:
//!
//! ```sh
//! docker compose up -d postgres valkey
//! createdb -h localhost -U ruchoir ruchoir_test   # or any empty database
//! RUCHOIR_TEST_DATABASE_URL=postgres://ruchoir:<password>@localhost:5432/ruchoir_test \
//!   VALKEY_TEST_URL=redis://localhost:6380 \
//!   cargo test -p ruchoir-api --bin ruchoir-api -- --nocapture
//! ```
//! (`VALKEY_TEST_URL` matches the published Valkey host port from `docker-compose.yml`.)
//!
//! Each run seeds fresh rows with random ids, so re-runs never collide and no teardown is needed.

#![cfg(test)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, DatabaseConnection, EntityTrait};
use serde_json::{json, Value};
use time::OffsetDateTime;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

use ruchoir_migration::{Migrator, MigratorTrait};

use crate::auth::cookie::SESSION_COOKIE;
use crate::config::Config;
use crate::entities::{channel_members, channels, conversations, space_members, spaces, users};
use crate::state::AppState;

/// Applies the migrations exactly once across all tests in this binary, so parallel `boot()` calls
/// never race two migration runners against the same database.
static SCHEMA_READY: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

/// A booted test server plus the handles the tests need.
struct TestApp {
    base: String,
    ws_url: String,
    db: DatabaseConnection,
    config: Config,
    valkey: fred::prelude::Pool,
    http: reqwest::Client,
}

/// Boot the app or return `None` when the test infrastructure is not configured.
async fn boot() -> Option<TestApp> {
    let Ok(database_url) = std::env::var("RUCHOIR_TEST_DATABASE_URL") else {
        eprintln!("skipping messaging integration tests: RUCHOIR_TEST_DATABASE_URL not set");
        return None;
    };
    let valkey_url =
        std::env::var("VALKEY_TEST_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());

    // Start from the process defaults, then point the datastores at the test instances.
    let mut config = Config::from_env().expect("config");
    config.database_url = database_url;
    config.valkey_url = valkey_url;
    config.auto_migrate = false;
    // Short presence TTL so an offline transition is observable quickly in tests.
    config.presence_ttl_secs = 5;

    let db = crate::db::connect(&config).await.expect("connect db");
    SCHEMA_READY
        .get_or_init(|| async {
            Migrator::up(&db, None).await.expect("migrate");
        })
        .await;
    let valkey = crate::cache::connect(&config)
        .await
        .expect("connect valkey");
    let hub = crate::realtime::Hub::start(&config, valkey.clone())
        .await
        .expect("hub");

    let webauthn = {
        let origin = webauthn_rs::prelude::Url::parse(&config.webauthn_origin).unwrap();
        webauthn_rs::WebauthnBuilder::new(&config.webauthn_rp_id, &origin)
            .unwrap()
            .rp_name("Ruchoir")
            .build()
            .unwrap()
    };

    let state = AppState {
        db: db.clone(),
        valkey: valkey.clone(),
        mailer: crate::auth::mailer::Mailer::from_config(&config).expect("mailer"),
        breaches: Arc::new(crate::auth::breach::BreachFilter::disabled()),
        secret_key: Arc::new([0x11u8; 32]),
        webauthn: Arc::new(webauthn),
        hub,
        // Object storage is not exercised by these tests; file byte endpoints report 503.
        storage: None,
        config: Arc::new(config.clone()),
    };

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let app = crate::http::router(state);
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("serve");
    });

    Some(TestApp {
        base: format!("http://{addr}"),
        ws_url: format!("ws://{addr}/api/v1/realtime/ws"),
        db,
        config,
        valkey,
        http: reqwest::Client::new(),
    })
}

impl TestApp {
    /// The `Cookie` header value carrying a live session for `user_id`.
    async fn cookie_for(&self, user_id: Uuid) -> String {
        let sid = crate::auth::session::create(&self.valkey, &self.config, user_id)
            .await
            .expect("session");
        format!("{SESSION_COOKIE}={sid}")
    }

    fn req(&self, method: reqwest::Method, path: &str, cookie: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{}", self.base, path))
            .header(reqwest::header::COOKIE, cookie.to_string())
    }

    /// Open a WebSocket authenticated as `cookie`.
    async fn connect_ws(&self, cookie: &str) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
        let mut request = self
            .ws_url
            .as_str()
            .into_client_request()
            .expect("ws request");
        request
            .headers_mut()
            .insert("cookie", cookie.parse().expect("cookie header"));
        let (ws, _) = tokio_tungstenite::connect_async(request)
            .await
            .expect("ws connect");
        ws
    }
}

/// Wait up to two seconds for the next JSON event on a socket.
async fn next_event(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) -> Option<Value> {
    loop {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                return serde_json::from_str(text.as_str()).ok();
            }
            Ok(Some(Ok(_))) => continue, // ping/pong/other: keep waiting
            _ => return None,
        }
    }
}

/// Assert no `message.created` event arrives within a short window. Presence and typing events for
/// space co-members are expected background noise and are ignored.
async fn expect_no_message(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) {
    let deadline = Duration::from_millis(800);
    while let Ok(Some(Ok(WsMessage::Text(text)))) = tokio::time::timeout(deadline, ws.next()).await
    {
        let event: Value = match serde_json::from_str(text.as_str()) {
            Ok(event) => event,
            Err(_) => continue,
        };
        if event["type"] == "message.created" {
            panic!("expected no message but received one: {text}");
        }
        // Presence/typing/other: ignore and keep watching until the window elapses.
    }
}

/// Seed a space with three members and a public + private channel. Returns the ids the tests use.
struct Fixture {
    space_id: Uuid,
    public_channel: Uuid,
    private_channel: Uuid,
    alice: Uuid,
    bob: Uuid,
    carol: Uuid,
}

async fn seed(db: &DatabaseConnection) -> Fixture {
    let space_id = Uuid::new_v4();
    spaces::ActiveModel {
        id: Set(space_id),
        name: Set("Test Space".to_owned()),
        slug: Set(format!("test-{}", space_id.simple())),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("space");

    let alice = make_user(db, "alice").await;
    let bob = make_user(db, "bob").await;
    let carol = make_user(db, "carol").await;
    for user in [alice, bob, carol] {
        space_members::ActiveModel {
            space_id: Set(space_id),
            user_id: Set(user),
            role: Set("member".to_owned()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("space member");
    }

    let public_channel = make_channel(db, space_id, "general", "public").await;
    // Alice and Bob join the public channel (so they are pushed); Carol does not.
    for user in [alice, bob] {
        add_channel_member(db, public_channel, user).await;
    }

    let private_channel = make_channel(db, space_id, "secret", "private").await;
    add_channel_member(db, private_channel, alice).await;

    Fixture {
        space_id,
        public_channel,
        private_channel,
        alice,
        bob,
        carol,
    }
}

async fn make_user(db: &DatabaseConnection, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    users::ActiveModel {
        id: Set(id),
        email: Set(format!("{name}-{}@example.test", id.simple())),
        display_name: Set(name.to_owned()),
        password_hash: Set(None),
        status: Set("active".to_owned()),
        mfa_enforced: Set(false),
        is_bot: Set(false),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("user");
    id
}

async fn make_channel(db: &DatabaseConnection, space_id: Uuid, name: &str, kind: &str) -> Uuid {
    let id = Uuid::new_v4();
    conversations::ActiveModel {
        id: Set(id),
        space_id: Set(space_id),
        kind: Set("channel".to_owned()),
        created_at: Set(OffsetDateTime::now_utc()),
    }
    .insert(db)
    .await
    .expect("conversation");
    channels::ActiveModel {
        id: Set(id),
        space_id: Set(space_id),
        name: Set(name.to_owned()),
        channel_type: Set(kind.to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("channel");
    id
}

async fn add_channel_member(db: &DatabaseConnection, channel_id: Uuid, user_id: Uuid) {
    channel_members::ActiveModel {
        channel_id: Set(channel_id),
        user_id: Set(user_id),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("channel member");
}

#[tokio::test]
async fn send_is_persisted_and_visible_to_a_member() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;

    let created = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &alice,
        )
        .json(&json!({ "body": "hello @bob" }))
        .send()
        .await
        .expect("send");
    assert_eq!(created.status(), 201, "author can post to a public channel");
    let body: Value = created.json().await.expect("json");
    assert_eq!(body["body"], "hello @bob");
    // The @bob mention resolved to a stored user mention.
    assert!(body["mentions"]
        .as_array()
        .map(|m| !m.is_empty())
        .unwrap_or(false));

    let page = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &bob,
        )
        .send()
        .await
        .expect("history");
    assert_eq!(page.status(), 200);
    let page: Value = page.json().await.expect("json");
    assert_eq!(page["messages"].as_array().expect("array").len(), 1);
}

#[tokio::test]
async fn message_is_pushed_only_to_channel_members() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let carol = app.cookie_for(fx.carol).await;

    let mut bob_ws = app.connect_ws(&bob).await;
    let mut carol_ws = app.connect_ws(&carol).await;
    // Drain any presence events emitted on connect.
    let _ = tokio::time::timeout(Duration::from_millis(300), bob_ws.next()).await;
    let _ = tokio::time::timeout(Duration::from_millis(300), carol_ws.next()).await;

    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/conversations/{}/messages", fx.public_channel),
        &alice,
    )
    .json(&json!({ "body": "for members only" }))
    .send()
    .await
    .expect("send");

    // Bob (a channel member) receives the message; Carol (space member, not in the channel) does not.
    let event = wait_for_type(&mut bob_ws, "message.created").await;
    assert_eq!(event["payload"]["body"], "for members only");
    expect_no_message(&mut carol_ws).await;
}

/// Read events until one of `event_type` arrives (or time out and panic).
async fn wait_for_type(
    ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
    event_type: &str,
) -> Value {
    for _ in 0..10 {
        match next_event(ws).await {
            Some(event) if event["type"] == event_type => return event,
            Some(_) => continue,
            None => break,
        }
    }
    panic!("did not receive a {event_type} event");
}

#[tokio::test]
async fn private_channel_denies_a_non_member() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let bob = app.cookie_for(fx.bob).await;

    let response = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{}/messages", fx.private_channel),
            &bob,
        )
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), 403, "bob is not in the private channel");
}

#[tokio::test]
async fn only_the_author_can_edit() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;

    let created: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &alice,
        )
        .json(&json!({ "body": "original" }))
        .send()
        .await
        .expect("send")
        .json()
        .await
        .expect("json");
    let message_id = created["id"].as_str().expect("id");

    let forbidden = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/messages/{message_id}"),
            &bob,
        )
        .json(&json!({ "body": "hijacked" }))
        .send()
        .await
        .expect("patch");
    assert_eq!(forbidden.status(), 403, "bob cannot edit alice's message");

    let edited = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/messages/{message_id}"),
            &alice,
        )
        .json(&json!({ "body": "corrected" }))
        .send()
        .await
        .expect("patch");
    assert_eq!(edited.status(), 200);
    let edited: Value = edited.json().await.expect("json");
    assert_eq!(edited["body"], "corrected");
    assert_eq!(edited["edited"], true);
}

#[tokio::test]
async fn reactions_toggle_idempotently() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;

    let created: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &alice,
        )
        .json(&json!({ "body": "react to me" }))
        .send()
        .await
        .expect("send")
        .json()
        .await
        .expect("json");
    let message_id = created["id"].as_str().expect("id");
    // A URL-encoded thumbs-up emoji.
    let emoji = "%F0%9F%91%8D";

    for _ in 0..2 {
        let put = app
            .req(
                reqwest::Method::PUT,
                &format!("/api/v1/messages/{message_id}/reactions/{emoji}"),
                &alice,
            )
            .send()
            .await
            .expect("react");
        assert_eq!(put.status(), 204);
    }

    let page: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &alice,
        )
        .send()
        .await
        .expect("history")
        .json()
        .await
        .expect("json");
    let reactions = page["messages"][0]["reactions"]
        .as_array()
        .expect("reactions");
    assert_eq!(reactions.len(), 1, "double PUT is idempotent");
    assert_eq!(reactions[0]["count"], 1);
    assert_eq!(reactions[0]["mine"], true);
}

#[tokio::test]
async fn create_dm_is_idempotent_by_participants() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;

    let first: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/dm", fx.space_id),
            &alice,
        )
        .json(&json!({ "user_ids": [fx.bob] }))
        .send()
        .await
        .expect("dm")
        .json()
        .await
        .expect("json");
    let second: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/dm", fx.space_id),
            &alice,
        )
        .json(&json!({ "user_ids": [fx.bob] }))
        .send()
        .await
        .expect("dm")
        .json()
        .await
        .expect("json");
    assert_eq!(first["id"], second["id"], "the same DM is reused");
}

#[tokio::test]
async fn creating_a_space_starts_it_with_an_owner_and_a_channel() {
    let Some(app) = boot().await else { return };
    let founder = make_user(&app.db, "founder").await;
    let cookie = app.cookie_for(founder).await;

    // Space slugs are unique across the workspace and this test database is not reset between runs,
    // so the name carries a unique token; the assertion is on the folding, not on a fixed string.
    let token = Uuid::new_v4().simple().to_string();
    let name = format!("Atelier Néon {token}");
    let created = app
        .req(reqwest::Method::POST, "/api/v1/spaces", &cookie)
        .json(&json!({ "name": name }))
        .send()
        .await
        .expect("create space");
    assert_eq!(created.status(), 201);
    let space: Value = created.json().await.expect("json");
    assert_eq!(space["name"], name);
    // The slug is the folded handle, so an accented name still yields a URL-safe one.
    assert_eq!(space["slug"], format!("atelier-neon-{token}"));
    assert_eq!(space["role"], "owner");
    assert_eq!(space["members"], 1);

    // The founder can reach it straight away, and it is not an empty shell.
    let spaces: Value = app
        .req(reqwest::Method::GET, "/api/v1/me/spaces", &cookie)
        .send()
        .await
        .expect("list spaces")
        .json()
        .await
        .expect("json");
    assert!(spaces
        .as_array()
        .expect("array")
        .iter()
        .any(|s| s["id"] == space["id"]));

    let channels: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/channels", space["id"].as_str().unwrap()),
            &cookie,
        )
        .send()
        .await
        .expect("list channels")
        .json()
        .await
        .expect("json");
    let channels = channels.as_array().expect("array");
    assert_eq!(channels.len(), 1);
    assert_eq!(channels[0]["name"], "general");
}

#[tokio::test]
async fn a_channel_name_is_normalised_and_unique_within_its_space() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let path = format!("/api/v1/spaces/{}/channels", fx.space_id);

    let created = app
        .req(reqwest::Method::POST, &path, &alice)
        .json(&json!({ "name": "Comptabilité 2027", "type": "public" }))
        .send()
        .await
        .expect("create channel");
    assert_eq!(created.status(), 201);
    let channel: Value = created.json().await.expect("json");
    assert_eq!(channel["name"], "comptabilite-2027");

    // The same name in any spelling collides: the handle is what identifies a channel.
    for name in [
        "Comptabilité 2027",
        "comptabilite-2027",
        "COMPTABILITE 2027",
    ] {
        let again = app
            .req(reqwest::Method::POST, &path, &alice)
            .json(&json!({ "name": name, "type": "private" }))
            .send()
            .await
            .expect("create duplicate");
        assert_eq!(again.status(), 400, "duplicate name {name} is refused");
    }

    // A channel cannot be created already archived.
    let archived = app
        .req(reqwest::Method::POST, &path, &alice)
        .json(&json!({ "name": "vieux-dossiers", "type": "archived" }))
        .send()
        .await
        .expect("create archived");
    assert_eq!(archived.status(), 400);
}

#[tokio::test]
async fn archiving_a_channel_makes_it_read_only() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;

    // Alice owns the channel she creates, so she may moderate it.
    let channel: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &alice,
        )
        .json(&json!({ "name": "chantier", "type": "public" }))
        .send()
        .await
        .expect("create channel")
        .json()
        .await
        .expect("json");
    let channel_id = channel["id"].as_str().expect("id").to_owned();

    let posted = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{channel_id}/messages"),
            &alice,
        )
        .json(&json!({ "body": "avant archivage" }))
        .send()
        .await
        .expect("send");
    assert_eq!(posted.status(), 201);

    let archived = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/channels/{channel_id}"),
            &alice,
        )
        .json(&json!({ "type": "archived" }))
        .send()
        .await
        .expect("archive");
    assert_eq!(archived.status(), 200);
    let archived: Value = archived.json().await.expect("json");
    assert_eq!(archived["type"], "archived");

    let refused = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{channel_id}/messages"),
            &alice,
        )
        .json(&json!({ "body": "après archivage" }))
        .send()
        .await
        .expect("send to archived");
    assert_eq!(
        refused.status(),
        403,
        "an archived channel takes no message"
    );

    // The history stays readable: archiving is not a deletion.
    let page: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{channel_id}/messages"),
            &alice,
        )
        .send()
        .await
        .expect("history")
        .json()
        .await
        .expect("json");
    assert_eq!(page["messages"].as_array().expect("array").len(), 1);
}

#[tokio::test]
async fn joining_and_leaving_only_touches_the_callers_membership() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let carol = app.cookie_for(fx.carol).await;
    let membership = format!("/api/v1/channels/{}/membership", fx.public_channel);

    // Carol is in the space but not in the channel: joining a public one needs no invitation.
    let joined = app
        .req(reqwest::Method::PUT, &membership, &carol)
        .send()
        .await
        .expect("join");
    assert_eq!(joined.status(), 204);
    assert!(
        channel_members::Entity::find_by_id((fx.public_channel, fx.carol))
            .one(&app.db)
            .await
            .expect("query")
            .is_some()
    );
    // Joining twice is not an error.
    let again = app
        .req(reqwest::Method::PUT, &membership, &carol)
        .send()
        .await
        .expect("join again");
    assert_eq!(again.status(), 204);

    let left = app
        .req(reqwest::Method::DELETE, &membership, &carol)
        .send()
        .await
        .expect("leave");
    assert_eq!(left.status(), 204);
    assert!(
        channel_members::Entity::find_by_id((fx.public_channel, fx.carol))
            .one(&app.db)
            .await
            .expect("query")
            .is_none()
    );
    // Bob, who was already a member, is untouched.
    assert!(
        channel_members::Entity::find_by_id((fx.public_channel, fx.bob))
            .one(&app.db)
            .await
            .expect("query")
            .is_some()
    );

    // A private channel is joined by invitation, so this endpoint refuses it.
    let private = app
        .req(
            reqwest::Method::PUT,
            &format!("/api/v1/channels/{}/membership", fx.private_channel),
            &carol,
        )
        .send()
        .await
        .expect("join private");
    assert_eq!(private.status(), 403);
}

#[tokio::test]
async fn a_new_channel_is_pushed_to_the_space_but_a_private_one_stays_hidden() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let mut bob_ws = app.connect_ws(&bob).await;
    let path = format!("/api/v1/spaces/{}/channels", fx.space_id);

    let created = app
        .req(reqwest::Method::POST, &path, &alice)
        .json(&json!({ "name": "livraisons", "type": "public" }))
        .send()
        .await
        .expect("create public channel");
    assert_eq!(created.status(), 201);

    // Bob is in the space, so a public channel appears in his sidebar without a reload.
    let event = wait_for_type(&mut bob_ws, "channel.created").await;
    assert_eq!(event["payload"]["name"], "livraisons");
    assert_eq!(event["payload"]["type"], "public");
    // The push carries no per-caller state: those fields differ for every recipient.
    assert!(event["payload"].get("unread").is_none());
    assert!(event["payload"].get("member").is_none());

    // A private channel's very existence is not public, so Bob hears nothing about it.
    let private = app
        .req(reqwest::Method::POST, &path, &alice)
        .json(&json!({ "name": "direction", "type": "private" }))
        .send()
        .await
        .expect("create private channel");
    assert_eq!(private.status(), 201);
    let private_id = private.json::<Value>().await.expect("json")["id"]
        .as_str()
        .expect("id")
        .to_owned();
    expect_no_channel_event(&mut bob_ws, &private_id).await;

    // Archiving the public one reaches him too: the sidebar has to show it as read-only.
    let channel_id = event["payload"]["id"].as_str().expect("id").to_owned();
    let archived = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/channels/{channel_id}"),
            &alice,
        )
        .json(&json!({ "type": "archived" }))
        .send()
        .await
        .expect("archive");
    assert_eq!(archived.status(), 200);
    let event = wait_for_type(&mut bob_ws, "channel.updated").await;
    assert_eq!(event["payload"]["id"], channel_id);
    assert_eq!(event["payload"]["type"], "archived");
}

/// Fail if any channel event about `channel_id` arrives within the window.
async fn expect_no_channel_event(
    ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
    channel_id: &str,
) {
    let deadline = Duration::from_millis(800);
    while let Ok(Some(Ok(WsMessage::Text(text)))) = tokio::time::timeout(deadline, ws.next()).await
    {
        let event: Value = match serde_json::from_str(text.as_str()) {
            Ok(event) => event,
            Err(_) => continue,
        };
        let is_channel_event =
            event["type"] == "channel.created" || event["type"] == "channel.updated";
        if is_channel_event && event["payload"]["id"] == channel_id {
            panic!("expected no event about this channel but received: {text}");
        }
    }
}
