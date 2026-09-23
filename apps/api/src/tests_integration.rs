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
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseBackend, DatabaseConnection,
    EntityTrait, IntoActiveModel, PaginatorTrait, QueryFilter, Statement,
};
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
use crate::entities::{
    channel_members, channel_pins, channels, conversations, dm_conversations, dm_participants,
    file_versions, files, import_mappings, message_attachments, message_reactions, messages,
    read_cursors, space_invitations, space_members, spaces, user_saved_messages, users,
};
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
        // Skipping is right on a developer's machine, where a database may not be running. It is
        // not right in CI: a suite that quietly tests nothing and reports success is worse than no
        // suite, and that is exactly how a defect one of these tests catches reached production.
        // So the skip becomes a failure wherever `CI` is set, which is every runner.
        assert!(
            std::env::var("CI").is_err(),
            "RUCHOIR_TEST_DATABASE_URL is unset in CI: these tests would silently pass \
             without running. Start a PostgreSQL and a Valkey for the job, or delete them."
        );
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
    // An import directory, so the tests of the server-side path exercise the real guard instead of
    // the "no directory configured" refusal, which answers the same 400 for a different reason.
    let import_dir = std::env::temp_dir().join("ruchoir-test-imports");
    std::fs::create_dir_all(&import_dir).expect("import dir");
    config.import_dir = Some(import_dir);

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
    spaces::ActiveModel {
        id: Set(space_id),
        default_channel_id: Set(Some(public_channel)),
        ..Default::default()
    }
    .update(db)
    .await
    .expect("default channel");
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

    // The history stays readable: archiving is not a deletion. Counted over what people wrote, not
    // over every row: a channel also carries the notice saying it was created.
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
    let written: Vec<&Value> = page["messages"]
        .as_array()
        .expect("array")
        .iter()
        .filter(|m| m["kind"] == "message")
        .collect();
    assert_eq!(written.len(), 1);
    assert_eq!(written[0]["body"], "avant archivage");
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

/// Promote a seeded member to `admin`, so they may administer the space's invitations.
async fn promote_to_admin(db: &DatabaseConnection, space_id: Uuid, user_id: Uuid) {
    set_space_role(db, space_id, user_id, "admin").await;
}

/// Put a seeded member on a given rung of the space ladder, without going through the endpoint that
/// changes roles: a test about what a role *can do* should not depend on somebody being able to
/// grant it.
async fn set_space_role(db: &DatabaseConnection, space_id: Uuid, user_id: Uuid, role: &str) {
    let member = space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await
        .expect("membership")
        .expect("member row");
    let mut active = member.into_active_model();
    active.role = Set(role.to_owned());
    active.update(db).await.expect("set role");
}

/// Extract the token from an invitation URL, which is the only place it ever appears.
fn token_of(url: &str) -> String {
    url.rsplit_once("token=")
        .expect("invitation url carries a token")
        .1
        .to_owned()
}

#[tokio::test]
async fn an_invited_account_joins_the_space_and_its_first_channel() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    let alice = app.cookie_for(fx.alice).await;

    // A newcomer who is in no space yet: the case the product could not handle at all before.
    let newcomer = make_user(&app.db, "newcomer").await;
    let newcomer_cookie = app.cookie_for(newcomer).await;

    let created = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/invitations", fx.space_id),
            &alice,
        )
        .json(&json!({ "role": "member" }))
        .send()
        .await
        .expect("create invitation");
    assert_eq!(created.status(), 201);
    let invitation: Value = created.json().await.expect("json");
    // A link invitation carries no address, so nothing is sent and its uses are unlimited.
    assert_eq!(invitation["emailed"], false);
    assert!(invitation["max_uses"].is_null());
    let token = token_of(invitation["url"].as_str().expect("url"));

    // The preview needs no session: the invitee has not signed in yet.
    let preview = app
        .http
        .get(format!("{}/api/v1/invitations/{token}", app.base))
        .send()
        .await
        .expect("preview");
    assert_eq!(preview.status(), 200);
    let preview: Value = preview.json().await.expect("json");
    assert_eq!(preview["space_name"], "Test Space");
    assert_eq!(preview["invited_by"], "alice");

    // Bob is already in the space and watching: the arrival has to reach him without a reload.
    let mut bob_ws = app.connect_ws(&app.cookie_for(fx.bob).await).await;

    let accepted = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/invitations/{token}/accept"),
            &newcomer_cookie,
        )
        .send()
        .await
        .expect("accept");
    assert_eq!(accepted.status(), 200);
    let space: Value = accepted.json().await.expect("json");
    assert_eq!(space["id"], fx.space_id.to_string());
    assert_eq!(space["role"], "member");

    let event = wait_for_type(&mut bob_ws, "member.joined").await;
    assert_eq!(event["payload"]["space_id"], fx.space_id.to_string());
    assert_eq!(event["payload"]["member"]["user_id"], newcomer.to_string());
    assert_eq!(event["payload"]["member"]["display_name"], "newcomer");
    assert_eq!(event["payload"]["member"]["role"], "member");

    // And the durable half: a system notice in the channel, carrying the event rather than a
    // sentence, and naming the person it is about so the client needs no second lookup.
    let notice = wait_for_type(&mut bob_ws, "message.created").await;
    assert_eq!(notice["conversation_id"], fx.public_channel.to_string());
    assert_eq!(notice["payload"]["kind"], "system");
    assert_eq!(notice["payload"]["system_event"], "member_joined");
    assert_eq!(notice["payload"]["author_id"], newcomer.to_string());
    assert_eq!(notice["payload"]["author_name"], "newcomer");
    assert_eq!(notice["payload"]["body"], "");

    // The membership row records who invited them, which nothing but the seed ever wrote before.
    let membership = space_members::Entity::find_by_id((fx.space_id, newcomer))
        .one(&app.db)
        .await
        .expect("query")
        .expect("membership");
    assert_eq!(membership.role, "member");
    assert_eq!(membership.invited_by, Some(fx.alice));

    // And they are in the space's first public channel, so messages reach them immediately rather
    // than after they think to join something.
    assert!(
        channel_members::Entity::find_by_id((fx.public_channel, newcomer))
            .one(&app.db)
            .await
            .expect("query")
            .is_some()
    );
}

#[tokio::test]
async fn only_an_administrator_may_invite() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    // Bob is a plain member, and Carol is promoted so the positive case is covered too.
    let bob = app.cookie_for(fx.bob).await;
    let path = format!("/api/v1/spaces/{}/invitations", fx.space_id);

    let refused = app
        .req(reqwest::Method::POST, &path, &bob)
        .json(&json!({}))
        .send()
        .await
        .expect("create invitation as a member");
    assert_eq!(refused.status(), 403);
    let hidden = app
        .req(reqwest::Method::GET, &path, &bob)
        .send()
        .await
        .expect("list invitations as a member");
    assert_eq!(hidden.status(), 403);

    promote_to_admin(&app.db, fx.space_id, fx.carol).await;
    let carol = app.cookie_for(fx.carol).await;
    let allowed = app
        .req(reqwest::Method::POST, &path, &carol)
        .json(&json!({}))
        .send()
        .await
        .expect("create invitation");
    assert_eq!(allowed.status(), 201);
}

#[tokio::test]
async fn an_addressed_invitation_only_admits_that_address() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    let alice = app.cookie_for(fx.alice).await;

    let invitee = make_user(&app.db, "invitee").await;
    let invitee_email = users::Entity::find_by_id(invitee)
        .one(&app.db)
        .await
        .expect("query")
        .expect("user")
        .email;
    let intruder = make_user(&app.db, "intruder").await;

    let created = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/invitations", fx.space_id),
            &alice,
        )
        .json(&json!({ "email": invitee_email }))
        .send()
        .await
        .expect("create invitation");
    assert_eq!(created.status(), 201);
    let invitation: Value = created.json().await.expect("json");
    // Addressed to one person, so it is single-use by default.
    assert_eq!(invitation["max_uses"], 1);
    let token = token_of(invitation["url"].as_str().expect("url"));

    // Forwarding the message does not hand over the space.
    let forwarded = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/invitations/{token}/accept"),
            &app.cookie_for(intruder).await,
        )
        .send()
        .await
        .expect("accept as intruder");
    assert_eq!(forwarded.status(), 403);
    assert!(space_members::Entity::find_by_id((fx.space_id, intruder))
        .one(&app.db)
        .await
        .expect("query")
        .is_none());

    // The addressee gets in, and the invitation is spent.
    let accepted = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/invitations/{token}/accept"),
            &app.cookie_for(invitee).await,
        )
        .send()
        .await
        .expect("accept as invitee");
    assert_eq!(accepted.status(), 200);

    let exhausted = app
        .http
        .get(format!("{}/api/v1/invitations/{token}", app.base))
        .send()
        .await
        .expect("preview");
    assert_eq!(exhausted.status(), 404);
}

#[tokio::test]
async fn accepting_twice_costs_one_use_and_revoking_ends_it() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    let alice = app.cookie_for(fx.alice).await;
    let newcomer = make_user(&app.db, "repeat").await;
    let newcomer_cookie = app.cookie_for(newcomer).await;
    let path = format!("/api/v1/spaces/{}/invitations", fx.space_id);

    let created: Value = app
        .req(reqwest::Method::POST, &path, &alice)
        .json(&json!({}))
        .send()
        .await
        .expect("create invitation")
        .json()
        .await
        .expect("json");
    let token = token_of(created["url"].as_str().expect("url"));
    let invitation_id = created["id"].as_str().expect("id").to_owned();

    for attempt in 0..2 {
        let accepted = app
            .req(
                reqwest::Method::POST,
                &format!("/api/v1/invitations/{token}/accept"),
                &newcomer_cookie,
            )
            .send()
            .await
            .expect("accept");
        assert_eq!(accepted.status(), 200, "attempt {attempt} succeeds");
    }

    // The second acceptance was a no-op: an existing member spends nothing, and announces nothing.
    let listed: Value = app
        .req(reqwest::Method::GET, &path, &alice)
        .send()
        .await
        .expect("list invitations")
        .json()
        .await
        .expect("json");
    let row = listed
        .as_array()
        .expect("array")
        .iter()
        .find(|row| row["id"] == invitation_id.as_str())
        .expect("the invitation is listed")
        .clone();
    assert_eq!(row["uses"], 1);
    assert_eq!(row["usable"], true);
    // The listing never carries the token, only what it was for.
    assert!(row.get("url").is_none() && row.get("token").is_none());

    let revoked = app
        .req(
            reqwest::Method::DELETE,
            &format!("{path}/{invitation_id}"),
            &alice,
        )
        .send()
        .await
        .expect("revoke");
    assert_eq!(revoked.status(), 204);

    let after = app
        .http
        .get(format!("{}/api/v1/invitations/{token}", app.base))
        .send()
        .await
        .expect("preview");
    assert_eq!(after.status(), 404, "a revoked invitation is gone");
}

/// The caller's row for one space in `GET /api/v1/me/spaces`.
async fn space_row(app: &TestApp, cookie: &str, space_id: Uuid) -> Value {
    let spaces: Value = app
        .req(reqwest::Method::GET, "/api/v1/me/spaces", cookie)
        .send()
        .await
        .expect("list spaces")
        .json()
        .await
        .expect("json");
    spaces
        .as_array()
        .expect("array")
        .iter()
        .find(|row| row["id"] == space_id.to_string())
        .expect("the space is listed")
        .clone()
}

#[tokio::test]
async fn space_counters_separate_mentions_from_other_activity() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let send = format!("/api/v1/conversations/{}/messages", fx.public_channel);

    // A freshly seeded space holds no messages, so both counters start at zero.
    let start = space_row(&app, &alice, fx.space_id).await;
    assert_eq!(start["unread"], 0);
    assert_eq!(start["mentions"], 0);

    // Bob writes in a channel they have both joined: activity, but nothing addressed to Alice.
    let posted = app
        .req(reqwest::Method::POST, &send, &bob)
        .json(&json!({ "body": "je passe en revue les devis" }))
        .send()
        .await
        .expect("send");
    assert_eq!(posted.status(), 201);

    let after_message = space_row(&app, &alice, fx.space_id).await;
    assert_eq!(after_message["unread"], 1, "the message counts as activity");
    assert_eq!(
        after_message["mentions"], 0,
        "nothing was addressed to Alice, so the rail shows no number"
    );

    // Naming her is a different thing entirely, and lands in her notification inbox.
    let mentioned = app
        .req(reqwest::Method::POST, &send, &bob)
        .json(&json!({ "body": "@alice tu peux confirmer ?" }))
        .send()
        .await
        .expect("send mention");
    assert_eq!(mentioned.status(), 201);

    let after_mention = space_row(&app, &alice, fx.space_id).await;
    assert_eq!(after_mention["unread"], 2);
    assert_eq!(after_mention["mentions"], 1);

    // Nobody named Bob, so his number stays empty even though he is in the same conversation.
    let for_bob = space_row(&app, &bob, fx.space_id).await;
    assert_eq!(for_bob["mentions"], 0);

    // Carol is in the space but joined neither channel: a conversation she has not joined is not
    // hers to be behind on.
    let carol = app.cookie_for(fx.carol).await;
    let for_carol = space_row(&app, &carol, fx.space_id).await;
    assert_eq!(for_carol["unread"], 0);
    assert_eq!(for_carol["mentions"], 0);
}

#[tokio::test]
async fn a_private_conversation_attachment_stays_in_that_conversation() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;

    // A file attached to the private channel, which only Alice is in. Inserted directly: object
    // storage is not configured in these tests, and this is a test of the authorization rule, not of
    // the byte path.
    let file_id = Uuid::new_v4();
    files::ActiveModel {
        id: Set(file_id),
        space_id: Set(fx.space_id),
        owner_id: Set(Some(fx.alice)),
        name: Set("bilan-confidentiel.pdf".to_owned()),
        kind: Set("file-text".to_owned()),
        conversation_id: Set(Some(fx.private_channel)),
        size_bytes: Set(1024),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("file");

    // Bob is in the space but not in that private channel: for him it does not exist.
    let bob = app.cookie_for(fx.bob).await;
    let denied = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/files/{file_id}/download"),
            &bob,
        )
        .send()
        .await
        .expect("download as a non-participant");
    assert_eq!(
        denied.status(),
        403,
        "space membership alone must not open a private conversation's attachment"
    );

    // Nor is it in the space's files, which is what everyone else browses.
    let listing: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/files", fx.space_id),
            &bob,
        )
        .send()
        .await
        .expect("list files")
        .json()
        .await
        .expect("json");
    assert!(
        !listing["entries"]
            .as_array()
            .expect("array")
            .iter()
            .any(|entry| entry["id"] == file_id.to_string()),
        "a conversation-private file must not appear in the space tree"
    );

    // Nor in a space-wide search, which would otherwise leak its name.
    let hits: Value = app
        .req(
            reqwest::Method::GET,
            &format!(
                "/api/v1/search?space_id={}&q=bilan-confidentiel",
                fx.space_id
            ),
            &bob,
        )
        .send()
        .await
        .expect("search")
        .json()
        .await
        .expect("json");
    assert!(
        !hits["files"]
            .as_array()
            .map(|files| files.iter().any(|f| f["id"] == file_id.to_string()))
            .unwrap_or(false),
        "a conversation-private file must not surface in search"
    );

    // Alice is in that channel, so authorization lets her through. The byte path then reports that
    // object storage is not configured, which is exactly how far this test needs to get: a 503 here
    // means the guard passed, where Bob got a 403 before reaching it.
    let alice = app.cookie_for(fx.alice).await;
    let allowed = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/files/{file_id}/download"),
            &alice,
        )
        .send()
        .await
        .expect("download as a participant");
    assert_eq!(
        allowed.status(),
        503,
        "a participant must pass authorization and fail only on the missing object store"
    );
}

#[tokio::test]
async fn an_addressed_invitation_registers_an_active_account() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    let alice = app.cookie_for(fx.alice).await;
    let path = format!("/api/v1/spaces/{}/invitations", fx.space_id);
    let address = format!("invitee-{}@example.test", Uuid::new_v4().simple());

    // Addressed to one person: the invitation is delivered to that mailbox, which is the same proof
    // a confirmation email would collect.
    let created: Value = app
        .req(reqwest::Method::POST, &path, &alice)
        .json(&json!({ "email": address }))
        .send()
        .await
        .expect("create invitation")
        .json()
        .await
        .expect("json");
    let token = token_of(created["url"].as_str().expect("url"));

    let registered = app
        .http
        .post(format!("{}/api/v1/auth/register", app.base))
        .json(&json!({
            "email": address,
            "display_name": "Invitee",
            "password": "Correct-Horse-42!",
            "invitation_token": token,
        }))
        .send()
        .await
        .expect("register from the invitation");
    assert_eq!(registered.status(), 201);
    let account: Value = registered.json().await.expect("json");
    assert_eq!(
        account["active"], true,
        "an invitation to this very address proves it, so no confirmation round trip"
    );

    // And the account can sign in straight away, which is the whole point: on an instance with no
    // SMTP relay the confirmation link would never reach anyone.
    let signed_in = app
        .http
        .post(format!("{}/api/v1/auth/login", app.base))
        .json(&json!({ "email": address, "password": "Correct-Horse-42!" }))
        .send()
        .await
        .expect("sign in");
    assert_eq!(signed_in.status(), 200);
}

#[tokio::test]
async fn a_shareable_link_still_requires_confirming_the_address() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    let alice = app.cookie_for(fx.alice).await;

    // No address on the invitation, so nothing about the registrant's address is proved by holding
    // it: the ordinary confirmation applies.
    let created: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/invitations", fx.space_id),
            &alice,
        )
        .json(&json!({}))
        .send()
        .await
        .expect("create link invitation")
        .json()
        .await
        .expect("json");
    let token = token_of(created["url"].as_str().expect("url"));

    let account: Value = app
        .http
        .post(format!("{}/api/v1/auth/register", app.base))
        .json(&json!({
            "email": format!("link-{}@example.test", Uuid::new_v4().simple()),
            "display_name": "From a link",
            "password": "Correct-Horse-42!",
            "invitation_token": token,
        }))
        .send()
        .await
        .expect("register from a shareable link")
        .json()
        .await
        .expect("json");
    assert_eq!(
        account["active"], false,
        "a link proves nothing about the address it was pasted to"
    );
}

/// A profile edit reaches the people who draw that identity, without them reloading.
///
/// The photo is the case that made this necessary: it is rendered by the member list, the mention
/// candidates, the message rows and the direct-message list, all fed by a roster loaded when the
/// space opened. Announcing the change is what keeps them from showing a stale face until the next
/// reload, which reads as the upload having failed.
#[tokio::test]
async fn a_profile_edit_reaches_the_people_who_draw_that_identity() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice_cookie = app.cookie_for(fx.alice).await;

    let mut bob_ws = app.connect_ws(&app.cookie_for(fx.bob).await).await;

    let updated = app
        .req(reqwest::Method::PATCH, "/api/v1/users/me", &alice_cookie)
        .json(&json!({ "display_name": "Alice Martin", "title": "Chief of staff" }))
        .send()
        .await
        .expect("patch profile");
    assert_eq!(updated.status(), 200);

    let event = wait_for_type(&mut bob_ws, "member.updated").await;
    assert_eq!(event["payload"]["user_id"], fx.alice.to_string());
    assert_eq!(event["payload"]["display_name"], "Alice Martin");
    assert_eq!(event["payload"]["title"], "Chief of staff");
    // Serialised even when there is none: absent would have to mean "unchanged", and this event
    // replaces an identity rather than patching one, so "no photo" must be sayable.
    assert!(
        event["payload"]["avatar_url"].is_null(),
        "an account with no avatar still carries the field, as null"
    );
}

/// Renaming a space moves its address, and the one it leaves behind keeps arriving.
///
/// The two halves are inseparable: an address that no longer resembles the space ages badly, and a
/// dead address is worse. Keeping every slug a space has answered to is what reconciles them, and it
/// is also what stops a later space from being minted on a retired one and inheriting its links.
#[tokio::test]
async fn renaming_a_space_moves_its_address_without_breaking_the_old_one() {
    let Some(app) = boot().await else { return };
    let founder = make_user(&app.db, "founder").await;
    let cookie = app.cookie_for(founder).await;

    // Unique names: this database is not reset between runs, and slugs are unique across it.
    let token = Uuid::new_v4().simple().to_string();
    let created: Value = app
        .req(reqwest::Method::POST, "/api/v1/spaces", &cookie)
        .json(&json!({ "name": format!("Atelier {token}") }))
        .send()
        .await
        .expect("create space")
        .json()
        .await
        .expect("json");
    let space_id = created["id"].as_str().expect("id").to_owned();
    let old_slug = created["slug"].as_str().expect("slug").to_owned();

    let renamed: Value = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/spaces/{space_id}"),
            &cookie,
        )
        .json(&json!({ "name": format!("Studio {token}") }))
        .send()
        .await
        .expect("rename")
        .json()
        .await
        .expect("json");
    assert_eq!(renamed["name"], format!("Studio {token}"));
    let new_slug = renamed["slug"].as_str().expect("slug").to_owned();
    assert_ne!(new_slug, old_slug, "the address follows the name");

    // The address people already hold still arrives, and says what it should now read as.
    let resolved: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/by-slug/{old_slug}"),
            &cookie,
        )
        .send()
        .await
        .expect("resolve old slug")
        .json()
        .await
        .expect("json");
    assert_eq!(resolved["id"], space_id);
    assert_eq!(resolved["slug"], new_slug);

    // And the retired slug cannot be handed to another space, which would inherit its links.
    let squatter: Value = app
        .req(reqwest::Method::POST, "/api/v1/spaces", &cookie)
        .json(&json!({ "name": format!("Atelier {token}") }))
        .send()
        .await
        .expect("create a space on the retired name")
        .json()
        .await
        .expect("json");
    assert_ne!(
        squatter["slug"], old_slug,
        "a retired address must never be reissued"
    );

    // A member who is neither owner nor admin cannot rename it.
    let outsider = make_user(&app.db, "outsider").await;
    let refused = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/spaces/{space_id}"),
            &app.cookie_for(outsider).await,
        )
        .json(&json!({ "name": "Chez moi" }))
        .send()
        .await
        .expect("rename as an outsider");
    assert_eq!(refused.status(), 403);
}

#[tokio::test]
async fn leaving_a_space_takes_the_membership_and_leaves_the_messages() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;

    // Something Alice wrote before walking out: it belongs to the channel, not to her membership.
    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/conversations/{}/messages", fx.public_channel),
        &alice,
    )
    .json(&json!({ "body": "before leaving" }))
    .send()
    .await
    .expect("send");

    let left = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{}/membership", fx.space_id),
            &alice,
        )
        .send()
        .await
        .expect("leave");
    assert_eq!(left.status(), 204);

    // The membership is gone, and so are the channel memberships inside the space (including the
    // private channel, whose access would otherwise outlive the space membership).
    assert!(space_members::Entity::find_by_id((fx.space_id, fx.alice))
        .one(&app.db)
        .await
        .expect("membership")
        .is_none());
    assert!(
        channel_members::Entity::find_by_id((fx.private_channel, fx.alice))
            .one(&app.db)
            .await
            .expect("channel membership")
            .is_none()
    );

    // The space is no longer hers to read, and no longer on her list.
    let refused = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &alice,
        )
        .send()
        .await
        .expect("channels");
    assert_eq!(refused.status(), 403);
    let spaces: Value = app
        .req(reqwest::Method::GET, "/api/v1/me/spaces", &alice)
        .send()
        .await
        .expect("list spaces")
        .json()
        .await
        .expect("json");
    assert!(!spaces
        .as_array()
        .expect("array")
        .iter()
        .any(|s| s["id"] == fx.space_id.to_string()));

    // What she wrote is still there for the people who stayed, and the departure left a notice.
    let page: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &bob,
        )
        .send()
        .await
        .expect("history")
        .json()
        .await
        .expect("json");
    let messages = page["messages"].as_array().expect("array");
    assert!(messages.iter().any(|m| m["body"] == "before leaving"));
    assert!(messages
        .iter()
        .any(|m| m["system_event"] == "member_left" && m["author_id"] == fx.alice.to_string()));
}

#[tokio::test]
async fn the_last_owner_cannot_leave_but_can_delete() {
    let Some(app) = boot().await else { return };
    let founder = make_user(&app.db, "founder").await;
    let cookie = app.cookie_for(founder).await;
    let created: Value = app
        .req(reqwest::Method::POST, "/api/v1/spaces", &cookie)
        .json(&json!({ "name": format!("Atelier {}", Uuid::new_v4().simple()) }))
        .send()
        .await
        .expect("create space")
        .json()
        .await
        .expect("json");
    let space_id: Uuid = created["id"].as_str().expect("id").parse().expect("uuid");

    // Walking out would leave the space with nobody able to administer it.
    let refused = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{space_id}/membership"),
            &cookie,
        )
        .send()
        .await
        .expect("leave");
    assert_eq!(refused.status(), 409);
    assert!(space_members::Entity::find_by_id((space_id, founder))
        .one(&app.db)
        .await
        .expect("membership")
        .is_some());

    // Deleting is the way out, and it takes the space's channels with it through the cascade.
    let deleted = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{space_id}"),
            &cookie,
        )
        .send()
        .await
        .expect("delete");
    assert_eq!(deleted.status(), 204);
    assert!(spaces::Entity::find_by_id(space_id)
        .one(&app.db)
        .await
        .expect("space")
        .is_none());
    assert!(channels::Entity::find()
        .filter(channels::Column::SpaceId.eq(space_id))
        .all(&app.db)
        .await
        .expect("channels")
        .is_empty());
}

#[tokio::test]
async fn an_administrator_may_not_delete_a_space() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.bob).await;
    let bob = app.cookie_for(fx.bob).await;

    let refused = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{}", fx.space_id),
            &bob,
        )
        .send()
        .await
        .expect("delete");
    assert_eq!(refused.status(), 403, "running a space is not ending it");
    assert!(spaces::Entity::find_by_id(fx.space_id)
        .one(&app.db)
        .await
        .expect("space")
        .is_some());
}

/// Set a member's role through the endpoint, returning the status and the body it answered with.
async fn set_role(
    app: &TestApp,
    cookie: &str,
    space_id: Uuid,
    user_id: Uuid,
    role: &str,
) -> (reqwest::StatusCode, Value) {
    let response = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/spaces/{space_id}/members/{user_id}"),
            cookie,
        )
        .json(&json!({ "role": role }))
        .send()
        .await
        .expect("set role");
    let status = response.status();
    let body = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// The role a membership currently holds, read straight from the table.
async fn role_of(db: &DatabaseConnection, space_id: Uuid, user_id: Uuid) -> String {
    space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await
        .expect("membership")
        .expect("member row")
        .role
}

#[tokio::test]
async fn handing_a_space_over_makes_the_former_owner_an_admin() {
    let Some(app) = boot().await else { return };
    let founder = make_user(&app.db, "founder").await;
    let heir = make_user(&app.db, "heir").await;
    let cookie = app.cookie_for(founder).await;
    let created: Value = app
        .req(reqwest::Method::POST, "/api/v1/spaces", &cookie)
        .json(&json!({ "name": format!("Atelier {}", Uuid::new_v4().simple()) }))
        .send()
        .await
        .expect("create space")
        .json()
        .await
        .expect("json");
    let space_id: Uuid = created["id"].as_str().expect("id").parse().expect("uuid");
    space_members::ActiveModel {
        space_id: Set(space_id),
        user_id: Set(heir),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("space member");

    let (status, body) = set_role(&app, &cookie, space_id, heir, "owner").await;
    assert_eq!(status, 200);
    // Both sides of the transfer come back, because both have to be redrawn.
    let changes = body.as_array().expect("array");
    assert_eq!(changes.len(), 2);
    assert_eq!(role_of(&app.db, space_id, heir).await, "owner");
    assert_eq!(
        role_of(&app.db, space_id, founder).await,
        "admin",
        "a space has one owner, so handing it over is a step down"
    );

    // And the step down is real: an admin cannot reach the owner's membership any more.
    let (refused, _) = set_role(&app, &cookie, space_id, heir, "member").await;
    assert_eq!(refused, 403);
}

#[tokio::test]
async fn an_admin_may_not_hand_out_their_own_rank_or_touch_it() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.bob).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;

    // Below them: allowed.
    let (demoted, _) = set_role(&app, &bob, fx.space_id, fx.carol, "guest").await;
    assert_eq!(demoted, 200);
    assert_eq!(role_of(&app.db, fx.space_id, fx.carol).await, "guest");

    // Their own rank: only the owner names administrators.
    let (refused, _) = set_role(&app, &bob, fx.space_id, fx.carol, "admin").await;
    assert_eq!(refused, 403);
    assert_eq!(role_of(&app.db, fx.space_id, fx.carol).await, "guest");

    // Someone holding it: not theirs to take away either.
    let (peer, _) = set_role(&app, &bob, fx.space_id, fx.alice, "member").await;
    assert_eq!(peer, 403);
    assert_eq!(role_of(&app.db, fx.space_id, fx.alice).await, "admin");

    // Their own membership, which is the same rule seen from the inside.
    let (own, _) = set_role(&app, &bob, fx.space_id, fx.bob, "owner").await;
    assert_eq!(own, 403);
    assert_eq!(role_of(&app.db, fx.space_id, fx.bob).await, "admin");
}

/// Turn a seeded member into a guest of their space.
async fn make_guest(db: &DatabaseConnection, space_id: Uuid, user_id: Uuid) {
    let member = space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await
        .expect("membership")
        .expect("member row");
    let mut active = member.into_active_model();
    active.role = Set("guest".to_owned());
    active.update(db).await.expect("demote to guest");
}

#[tokio::test]
async fn a_guest_reaches_only_what_they_were_added_to() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    // Carol is in the space and in no channel; Alice and Bob are in the public one.
    make_guest(&app.db, fx.space_id, fx.carol).await;
    let carol = app.cookie_for(fx.carol).await;

    // The public channel is public to members, and she is not that kind of member.
    let refused = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &carol,
        )
        .send()
        .await
        .expect("history");
    assert_eq!(refused.status(), 403, "a guest inherits no channel");

    // It is not listed to her either, so the refusal is not a surprise waiting to happen.
    let channels: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &carol,
        )
        .send()
        .await
        .expect("channels")
        .json()
        .await
        .expect("json");
    assert!(channels.as_array().expect("array").is_empty());

    // Nor may she open a room of her own, or walk into one.
    let created = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &carol,
        )
        .json(&json!({ "name": "chez-moi", "type": "public" }))
        .send()
        .await
        .expect("create channel");
    assert_eq!(created.status(), 403);
    let joined = app
        .req(
            reqwest::Method::PUT,
            &format!("/api/v1/channels/{}/membership", fx.public_channel),
            &carol,
        )
        .send()
        .await
        .expect("join");
    assert_eq!(joined.status(), 403);

    // Added to the channel by someone who may: now it is hers, and only that one.
    add_channel_member(&app.db, fx.public_channel, fx.carol).await;
    let page = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &carol,
        )
        .send()
        .await
        .expect("history");
    assert_eq!(
        page.status(),
        200,
        "an explicit row is the whole of the rule"
    );
    let private = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{}/messages", fx.private_channel),
            &carol,
        )
        .send()
        .await
        .expect("private history");
    assert_eq!(private.status(), 403);
}

#[tokio::test]
async fn a_guest_is_shown_the_people_they_share_a_conversation_with() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    make_guest(&app.db, fx.space_id, fx.carol).await;
    let carol = app.cookie_for(fx.carol).await;

    // In no conversation yet: the roster is herself and nobody else.
    let alone: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/members", fx.space_id),
            &carol,
        )
        .send()
        .await
        .expect("members")
        .json()
        .await
        .expect("json");
    let alone = alone.as_array().expect("array");
    assert_eq!(alone.len(), 1);
    assert_eq!(alone[0]["user_id"], fx.carol.to_string());

    // A profile she has no conversation with stays closed, and so does a direct message to them.
    let profile = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/users/{}", fx.bob),
            &carol,
        )
        .send()
        .await
        .expect("profile");
    assert_eq!(profile.status(), 403);
    let dm = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/dm", fx.space_id),
            &carol,
        )
        .json(&json!({ "user_ids": [fx.bob] }))
        .send()
        .await
        .expect("dm");
    assert_eq!(dm.status(), 403);

    // Added to the public channel, she gains exactly the people in it: Alice and Bob.
    add_channel_member(&app.db, fx.public_channel, fx.carol).await;
    let roster: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/members", fx.space_id),
            &carol,
        )
        .send()
        .await
        .expect("members")
        .json()
        .await
        .expect("json");
    let ids: Vec<String> = roster
        .as_array()
        .expect("array")
        .iter()
        .map(|m| m["user_id"].as_str().expect("id").to_owned())
        .collect();
    assert_eq!(ids.len(), 3);
    assert!(ids.contains(&fx.alice.to_string()));
    assert!(ids.contains(&fx.bob.to_string()));
    assert!(ids.contains(&fx.carol.to_string()));
}

#[tokio::test]
async fn a_guest_gets_no_space_files_but_keeps_the_ones_they_can_see() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    make_guest(&app.db, fx.space_id, fx.carol).await;
    add_channel_member(&app.db, fx.public_channel, fx.carol).await;
    let carol = app.cookie_for(fx.carol).await;
    let alice = app.cookie_for(fx.alice).await;

    // The space tree is the organisation's, and she is not in the space that way.
    let tree = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/files", fx.space_id),
            &carol,
        )
        .send()
        .await
        .expect("tree");
    assert_eq!(tree.status(), 403);

    // A file sitting in that tree is closed to her too.
    let file_id = Uuid::new_v4();
    files::ActiveModel {
        id: Set(file_id),
        space_id: Set(fx.space_id),
        owner_id: Set(Some(fx.alice)),
        name: Set("plan.pdf".to_owned()),
        kind: Set("file".to_owned()),
        size_bytes: Set(12),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("file");
    // Asked through the share list, which is the one read that needs no object store to answer.
    let closed = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/files/{file_id}/shares"),
            &carol,
        )
        .send()
        .await
        .expect("file");
    assert_eq!(closed.status(), 403);

    // Until it is attached to a message in a channel she is in: she sees the message, so she gets
    // the document it is about.
    let sent: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &alice,
        )
        .json(&json!({ "body": "le plan", "attachments": [file_id] }))
        .send()
        .await
        .expect("send")
        .json()
        .await
        .expect("json");
    assert!(sent["id"].is_string());
    let opened = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/files/{file_id}/shares"),
            &carol,
        )
        .send()
        .await
        .expect("file");
    assert_eq!(opened.status(), 200);
}

#[tokio::test]
async fn removing_a_member_follows_the_same_rank_rule_as_a_role() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.bob).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;

    // An admin does not remove another admin, nor themselves (that is leaving, and it reads
    // differently in the history afterwards).
    for (target, expected) in [(fx.alice, 403), (fx.bob, 403)] {
        let refused = app
            .req(
                reqwest::Method::DELETE,
                &format!("/api/v1/spaces/{}/members/{}", fx.space_id, target),
                &bob,
            )
            .send()
            .await
            .expect("remove");
        assert_eq!(refused.status(), expected);
    }

    // Someone below them: removed, with their channel memberships, and their messages left alone.
    let removed = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{}/members/{}", fx.space_id, fx.carol),
            &bob,
        )
        .send()
        .await
        .expect("remove");
    assert_eq!(removed.status(), 204);
    assert!(space_members::Entity::find_by_id((fx.space_id, fx.carol))
        .one(&app.db)
        .await
        .expect("membership")
        .is_none());

    // The space is no longer hers, and the channel says what happened rather than that she left.
    let refused = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &app.cookie_for(fx.carol).await,
        )
        .send()
        .await
        .expect("channels");
    assert_eq!(refused.status(), 403);
    let page: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &bob,
        )
        .send()
        .await
        .expect("history")
        .json()
        .await
        .expect("json");
    assert!(page["messages"]
        .as_array()
        .expect("array")
        .iter()
        .any(|m| m["system_event"] == "member_removed" && m["author_id"] == fx.carol.to_string()));
}

#[tokio::test]
async fn a_channel_says_who_came_and_who_went() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let carol = app.cookie_for(fx.carol).await;

    // Carol walks into the public channel herself.
    let joined = app
        .req(
            reqwest::Method::PUT,
            &format!("/api/v1/channels/{}/membership", fx.public_channel),
            &carol,
        )
        .send()
        .await
        .expect("join");
    assert_eq!(joined.status(), 204);

    let notices = |messages: &Value, event: &str, who: Uuid| {
        messages
            .as_array()
            .expect("array")
            .iter()
            .filter(|m| m["system_event"] == event && m["author_id"] == who.to_string())
            .count()
    };
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
    assert_eq!(notices(&page["messages"], "channel_joined", fx.carol), 1);

    // Pressing join again changes nothing, and says nothing.
    app.req(
        reqwest::Method::PUT,
        &format!("/api/v1/channels/{}/membership", fx.public_channel),
        &carol,
    )
    .send()
    .await
    .expect("join twice");
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
    assert_eq!(notices(&page["messages"], "channel_joined", fx.carol), 1);

    // And leaving leaves its own trace, for the people who stayed.
    let left = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/channels/{}/membership", fx.public_channel),
            &carol,
        )
        .send()
        .await
        .expect("leave");
    assert_eq!(left.status(), 204);
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
    assert_eq!(notices(&page["messages"], "channel_left", fx.carol), 1);
}

#[tokio::test]
async fn a_new_channel_says_it_was_created() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;

    let created: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &alice,
        )
        .json(&json!({ "name": format!("sujet-{}", Uuid::new_v4().simple()), "type": "public" }))
        .send()
        .await
        .expect("create")
        .json()
        .await
        .expect("json");
    let channel_id = created["id"].as_str().expect("id");

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
    // A notice about nobody in particular: the channel was created, and the sentence names no one.
    assert!(page["messages"]
        .as_array()
        .expect("array")
        .iter()
        .any(|m| m["system_event"] == "channel_created" && m["author_id"].is_null()));
}

#[tokio::test]
async fn an_administrator_runs_a_space_but_does_not_own_it() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.bob).await;
    let bob = app.cookie_for(fx.bob).await;

    // The space's identity is the owner's: an administrator manages the people, not the name.
    let refused = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/spaces/{}", fx.space_id),
            &bob,
        )
        .json(&json!({ "name": "Atelier Repris" }))
        .send()
        .await
        .expect("rename");
    assert_eq!(refused.status(), 403);

    // What they do run, they still run: an invitation is theirs to issue.
    let invited = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/invitations", fx.space_id),
            &bob,
        )
        .json(&json!({ "role": "member" }))
        .send()
        .await
        .expect("invite");
    assert_eq!(invited.status(), 201);
}

#[tokio::test]
async fn a_reservation_never_shuts_out_the_space_owner() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    set_space_role(&app.db, fx.space_id, fx.alice, "owner").await;
    promote_to_admin(&app.db, fx.space_id, fx.bob).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;

    // An administrator makes a room for the externals, and leaves the owner out of the list. That is
    // theirs to want: the list is a rule about a room.
    let created = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &bob,
        )
        .json(&json!({
            "name": format!("externes-{}", Uuid::new_v4().simple()),
            "type": "public",
            "allowed_roles": ["guest", "admin"],
        }))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);
    let channel: Value = created.json().await.expect("json");
    let channel_id = channel["id"].as_str().expect("id").to_owned();

    // It is not a way to take a room out of the space from under the person who holds it. Before
    // this, the channel simply vanished from the owner's sidebar and only an API call brought it
    // back.
    let page = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{channel_id}/messages"),
            &alice,
        )
        .send()
        .await
        .expect("history");
    assert_eq!(
        page.status(),
        200,
        "an owner reads every channel of the space"
    );

    let channels: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &alice,
        )
        .send()
        .await
        .expect("channels")
        .json()
        .await
        .expect("json");
    assert!(
        channels
            .as_array()
            .expect("array")
            .iter()
            .any(|c| c["id"] == channel_id),
        "and it stays in their list"
    );

    // The restriction is still a restriction for everybody below: a plain member is refused.
    let refused = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{channel_id}/messages"),
            &app.cookie_for(fx.carol).await,
        )
        .send()
        .await
        .expect("history");
    assert_eq!(refused.status(), 403);
}

#[tokio::test]
async fn a_channel_reserved_to_roles_admits_only_those() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;

    // A room for the people who run the space. Alice is an admin, so she is in the list.
    let created = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &alice,
        )
        .json(&json!({
            "name": format!("direction-{}", Uuid::new_v4().simple()),
            "type": "public",
            "allowed_roles": ["owner", "admin"],
        }))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);
    let channel: Value = created.json().await.expect("json");
    let channel_id = channel["id"].as_str().expect("id").to_owned();

    // A public channel, and still closed to a plain member: the type says who may walk in, the list
    // says who may be there at all.
    let refused = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{channel_id}/messages"),
            &bob,
        )
        .send()
        .await
        .expect("history");
    assert_eq!(refused.status(), 403);
    let joined = app
        .req(
            reqwest::Method::PUT,
            &format!("/api/v1/channels/{channel_id}/membership"),
            &bob,
        )
        .send()
        .await
        .expect("join");
    assert_eq!(joined.status(), 403);

    // It is not offered to him either, and an admin cannot add him to it.
    let channels: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &bob,
        )
        .send()
        .await
        .expect("channels")
        .json()
        .await
        .expect("json");
    assert!(!channels
        .as_array()
        .expect("array")
        .iter()
        .any(|c| c["id"] == channel_id));
    let added = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/channels/{channel_id}/members"),
            &alice,
        )
        .json(&json!({ "user_ids": [fx.bob] }))
        .send()
        .await
        .expect("add");
    assert_eq!(added.status(), 400);

    // A room you are not in is a real thing to want (one for the externals, one for the people who
    // run the place), so reserving it to roles Alice does not hold is allowed...
    let excluded = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/channels/{channel_id}"),
            &alice,
        )
        .json(&json!({ "allowed_roles": ["guest"] }))
        .send()
        .await
        .expect("reserve");
    assert_eq!(excluded.status(), 200);

    // ...and it takes the channel away from her at once, membership row or not.
    let closed = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{channel_id}/messages"),
            &alice,
        )
        .send()
        .await
        .expect("history");
    assert_eq!(
        closed.status(),
        403,
        "a reservation excludes its own author too"
    );

    // But it is never a door that locks behind everyone: administering the space still reaches the
    // channel's settings, which is what makes the exclusion undoable.
    // Lifting the reservation opens it again, and Bob is offered it like any public channel.
    let lifted = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/channels/{channel_id}"),
            &alice,
        )
        .json(&json!({ "allowed_roles": [] }))
        .send()
        .await
        .expect("lift");
    assert_eq!(lifted.status(), 200);
    let page = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{channel_id}/messages"),
            &bob,
        )
        .send()
        .await
        .expect("history");
    assert_eq!(page.status(), 200);
}

#[tokio::test]
async fn a_reservation_takes_the_channel_back_when_a_role_changes() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    promote_to_admin(&app.db, fx.space_id, fx.bob).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;

    let channel: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &alice,
        )
        .json(&json!({
            "name": format!("direction-{}", Uuid::new_v4().simple()),
            "type": "private",
            "allowed_roles": ["owner", "admin"],
        }))
        .send()
        .await
        .expect("create")
        .json()
        .await
        .expect("json");
    let channel_id = channel["id"].as_str().expect("id").to_owned();
    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/channels/{channel_id}/members"),
        &alice,
    )
    .json(&json!({ "user_ids": [fx.bob] }))
    .send()
    .await
    .expect("add");

    let readable = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{channel_id}/messages"),
            &bob,
        )
        .send()
        .await
        .expect("history");
    assert_eq!(
        readable.status(),
        200,
        "an admin belongs in an admin channel"
    );

    // Demoted: the membership row is still there, and it no longer opens anything. A door somebody
    // walked through last week is not a right they keep.
    let member = space_members::Entity::find_by_id((fx.space_id, fx.bob))
        .one(&app.db)
        .await
        .expect("membership")
        .expect("member row");
    let mut active = member.into_active_model();
    active.role = Set("member".to_owned());
    active.update(&app.db).await.expect("demote");

    let refused = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{channel_id}/messages"),
            &bob,
        )
        .send()
        .await
        .expect("history");
    assert_eq!(refused.status(), 403);
}

#[tokio::test]
async fn a_channel_owner_names_moderators_and_a_moderator_names_nobody() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;

    // Alice opens the channel, so she owns it; Bob and Carol are in it.
    let channel: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &alice,
        )
        .json(&json!({ "name": format!("atelier-{}", Uuid::new_v4().simple()), "type": "private" }))
        .send()
        .await
        .expect("create")
        .json()
        .await
        .expect("json");
    let channel_id = channel["id"].as_str().expect("id").to_owned();
    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/channels/{channel_id}/members"),
        &alice,
    )
    .json(&json!({ "user_ids": [fx.bob, fx.carol] }))
    .send()
    .await
    .expect("add");

    // The owner names a moderator.
    let promoted = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/members/{}", fx.bob),
            &alice,
        )
        .json(&json!({ "role": "admin" }))
        .send()
        .await
        .expect("promote");
    assert_eq!(promoted.status(), 200);

    // A moderator hands out nothing of their own rank, and cannot touch the owner.
    for (target, role) in [(fx.carol, "admin"), (fx.alice, "member")] {
        let refused = app
            .req(
                reqwest::Method::PATCH,
                &format!("/api/v1/channels/{channel_id}/members/{target}"),
                &bob,
            )
            .json(&json!({ "role": role }))
            .send()
            .await
            .expect("promote");
        assert_eq!(refused.status(), 403);
    }

    // But they do moderate: an ordinary member is theirs to take out, and the channel says so.
    let removed = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/channels/{channel_id}/members/{}", fx.carol),
            &bob,
        )
        .send()
        .await
        .expect("remove");
    assert_eq!(removed.status(), 204);
    assert!(channel_members::Entity::find_by_id((
        channel_id.parse::<Uuid>().expect("uuid"),
        fx.carol
    ))
    .one(&app.db)
    .await
    .expect("membership")
    .is_none());
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
    assert!(page["messages"]
        .as_array()
        .expect("array")
        .iter()
        .any(|m| m["system_event"] == "channel_removed" && m["author_id"] == fx.carol.to_string()));

    // And the owner cannot be removed by the moderator either.
    let refused = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/channels/{channel_id}/members/{}", fx.alice),
            &bob,
        )
        .send()
        .await
        .expect("remove owner");
    assert_eq!(refused.status(), 403);
}

#[tokio::test]
async fn writing_in_a_channel_joins_it() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    // Carol is in the space and in no channel: she may read the public one without joining, which
    // is deliberate, and she used to be able to write in it without joining, which was not.
    let carol = app.cookie_for(fx.carol).await;
    assert!(
        channel_members::Entity::find_by_id((fx.public_channel, fx.carol))
            .one(&app.db)
            .await
            .expect("membership")
            .is_none()
    );

    let sent = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &carol,
        )
        .json(&json!({ "body": "bonjour" }))
        .send()
        .await
        .expect("send");
    assert_eq!(sent.status(), 201);

    // She is in it now, so the message's audience includes its own author: without this she wrote
    // to everyone except herself, with no echo, no unread count and no reply reaching her.
    assert!(
        channel_members::Entity::find_by_id((fx.public_channel, fx.carol))
            .one(&app.db)
            .await
            .expect("membership")
            .is_some()
    );
    // And the channel says who turned up, once.
    let page: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &carol,
        )
        .send()
        .await
        .expect("history")
        .json()
        .await
        .expect("json");
    assert_eq!(
        page["messages"]
            .as_array()
            .expect("array")
            .iter()
            .filter(
                |m| m["system_event"] == "channel_joined" && m["author_id"] == fx.carol.to_string()
            )
            .count(),
        1
    );
}

#[tokio::test]
async fn a_guest_is_not_told_about_a_channel_they_are_not_in() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    make_guest(&app.db, fx.space_id, fx.carol).await;
    let alice = app.cookie_for(fx.alice).await;
    let carol = app.cookie_for(fx.carol).await;
    let mut socket = app.connect_ws(&carol).await;

    // Alice opens a public channel. A guest does not see public channels, so nothing about it is
    // Carol's business yet: it used to arrive in her sidebar and stay there until she reloaded.
    let created: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &alice,
        )
        .json(&json!({ "name": format!("salon-{}", Uuid::new_v4().simple()), "type": "public" }))
        .send()
        .await
        .expect("create")
        .json()
        .await
        .expect("json");
    let channel_id = created["id"].as_str().expect("id").to_owned();
    expect_no_message(&mut socket).await;

    // Added to it, she is told at once, because now it is one of hers.
    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/channels/{channel_id}/members"),
        &alice,
    )
    .json(&json!({ "user_ids": [fx.carol] }))
    .send()
    .await
    .expect("add");
    let frame = wait_for_type(&mut socket, "channel.created").await;
    assert_eq!(frame["payload"]["id"], channel_id);
}

// ---------------------------------------------------------------------------
// Who may do what.
//
// One test per rank, each walking the same list of acts, because the interesting
// failures are not "does this endpoint work" but "does this endpoint refuse the
// person it should". A screen that hides a button is a courtesy; these are the
// guard. Written after a test session where an external guest could add people to
// a channel: nothing on the server had ever said they could not.
// ---------------------------------------------------------------------------

/// Send a request with no body and return its status.
async fn status_of(app: &TestApp, method: reqwest::Method, path: &str, cookie: &str) -> u16 {
    app.req(method, path, cookie)
        .send()
        .await
        .expect("request")
        .status()
        .as_u16()
}

/// Send a request with a JSON body and return its status.
async fn status_of_json(
    app: &TestApp,
    method: reqwest::Method,
    path: &str,
    cookie: &str,
    body: Value,
) -> u16 {
    app.req(method, path, cookie)
        .json(&body)
        .send()
        .await
        .expect("request")
        .status()
        .as_u16()
}

#[tokio::test]
async fn an_ordinary_member_administers_nothing() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    // Alice is an ordinary member of the space and a member of the public channel: the most
    // ordinary position there is, and the one that had the most quietly open doors.
    let alice = app.cookie_for(fx.alice).await;
    let space = fx.space_id;
    let channel = fx.public_channel;

    // The space is not theirs to run.
    assert_eq!(
        status_of_json(
            &app,
            reqwest::Method::PATCH,
            &format!("/api/v1/spaces/{space}"),
            &alice,
            json!({ "name": "Repris" })
        )
        .await,
        403,
        "renaming a space is the owner's"
    );
    assert_eq!(
        status_of_json(
            &app,
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{space}/invitations"),
            &alice,
            json!({ "role": "member" })
        )
        .await,
        403,
        "inviting is an administrator's"
    );
    assert_eq!(
        status_of_json(
            &app,
            reqwest::Method::PATCH,
            &format!("/api/v1/spaces/{space}/members/{}", fx.bob),
            &alice,
            json!({ "role": "guest" })
        )
        .await,
        403,
        "roles are an administrator's"
    );
    assert_eq!(
        status_of(
            &app,
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{space}/members/{}", fx.bob),
            &alice
        )
        .await,
        403,
        "removing someone is an administrator's"
    );
    assert_eq!(
        status_of(
            &app,
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{space}"),
            &alice
        )
        .await,
        403,
        "deleting a space is the owner's"
    );

    // Nor is the channel theirs to moderate, even the one they are in.
    assert_eq!(
        status_of_json(
            &app,
            reqwest::Method::POST,
            &format!("/api/v1/channels/{channel}/members"),
            &alice,
            json!({ "user_ids": [fx.carol] })
        )
        .await,
        403,
        "being in a channel is not deciding who else is"
    );
    assert_eq!(
        status_of(
            &app,
            reqwest::Method::DELETE,
            &format!("/api/v1/channels/{channel}/members/{}", fx.bob),
            &alice
        )
        .await,
        403
    );
    assert_eq!(
        status_of_json(
            &app,
            reqwest::Method::PATCH,
            &format!("/api/v1/channels/{channel}/members/{}", fx.bob),
            &alice,
            json!({ "role": "admin" })
        )
        .await,
        403
    );
    assert_eq!(
        status_of_json(
            &app,
            reqwest::Method::PATCH,
            &format!("/api/v1/channels/{channel}"),
            &alice,
            json!({ "name": "repris" })
        )
        .await,
        403,
        "renaming a channel is its moderators'"
    );

    // What an ordinary member may do, they still may: read, write, and leave.
    assert_eq!(
        status_of(
            &app,
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{channel}/messages"),
            &alice
        )
        .await,
        200
    );
    assert_eq!(
        status_of_json(
            &app,
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{channel}/messages"),
            &alice,
            json!({ "body": "bonjour" })
        )
        .await,
        201
    );
    assert_eq!(
        status_of(
            &app,
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{space}/membership"),
            &alice
        )
        .await,
        204
    );
}

#[tokio::test]
async fn an_external_guest_administers_nothing_and_sees_nothing_extra() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    make_guest(&app.db, fx.space_id, fx.carol).await;
    // In one channel, and only that one: the position an external guest is actually in.
    add_channel_member(&app.db, fx.public_channel, fx.carol).await;
    let carol = app.cookie_for(fx.carol).await;
    let space = fx.space_id;
    let channel = fx.public_channel;

    for (method, path, body) in [
        (
            reqwest::Method::POST,
            format!("/api/v1/spaces/{space}/channels"),
            Some(json!({ "name": "chez-moi", "type": "public" })),
        ),
        (
            reqwest::Method::POST,
            format!("/api/v1/spaces/{space}/invitations"),
            Some(json!({ "role": "member" })),
        ),
        (
            reqwest::Method::PATCH,
            format!("/api/v1/spaces/{space}"),
            Some(json!({ "name": "Repris" })),
        ),
        (
            reqwest::Method::PATCH,
            format!("/api/v1/spaces/{space}/members/{}", fx.bob),
            Some(json!({ "role": "guest" })),
        ),
        (
            reqwest::Method::DELETE,
            format!("/api/v1/spaces/{space}/members/{}", fx.bob),
            None,
        ),
        (
            reqwest::Method::POST,
            format!("/api/v1/channels/{channel}/members"),
            Some(json!({ "user_ids": [fx.bob] })),
        ),
        (
            reqwest::Method::DELETE,
            format!("/api/v1/channels/{channel}/members/{}", fx.alice),
            None,
        ),
        (
            reqwest::Method::PATCH,
            format!("/api/v1/channels/{channel}"),
            Some(json!({ "name": "repris" })),
        ),
        (
            reqwest::Method::GET,
            format!("/api/v1/spaces/{space}/files"),
            None,
        ),
        (
            reqwest::Method::GET,
            format!("/api/v1/conversations/{}/messages", fx.private_channel),
            None,
        ),
    ] {
        let status = match body {
            Some(json) => status_of_json(&app, method.clone(), &path, &carol, json).await,
            None => status_of(&app, method.clone(), &path, &carol).await,
        };
        assert_eq!(status, 403, "a guest must be refused {method} {path}");
    }

    // What they were brought in for still works.
    assert_eq!(
        status_of_json(
            &app,
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{channel}/messages"),
            &carol,
            json!({ "body": "bonjour" })
        )
        .await,
        201
    );
}

#[tokio::test]
async fn two_sessions_see_the_same_membership_change() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    let alice = app.cookie_for(fx.alice).await;
    let carol = app.cookie_for(fx.carol).await;

    // Carol writes in a public channel she never joined. She is put in it, so the arrival reaches
    // the people already there...
    let mut watching = app.connect_ws(&alice).await;
    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/conversations/{}/messages", fx.public_channel),
        &carol,
    )
    .json(&json!({ "body": "j'arrive" }))
    .send()
    .await
    .expect("send");
    let notice = wait_for_type(&mut watching, "message.created").await;
    assert_eq!(notice["payload"]["system_event"], "channel_joined");
    let written = wait_for_type(&mut watching, "message.created").await;
    assert_eq!(written["payload"]["body"], "j'arrive");

    // ...and, the point of joining at all, what is said next reaches *her*, which it could not do
    // when a non-member's message went out to an audience that did not include its author.
    let mut carols = app.connect_ws(&carol).await;
    app.req(
        reqwest::Method::POST,
        &format!("/api/v1/conversations/{}/messages", fx.public_channel),
        &alice,
    )
    .json(&json!({ "body": "bienvenue" }))
    .send()
    .await
    .expect("send");
    let heard = wait_for_type(&mut carols, "message.created").await;
    assert_eq!(heard["payload"]["body"], "bienvenue");
    // Alice's socket carries her own message too (the client drops its own echo, the socket does
    // not), so it has to be read before waiting for what comes after it.
    let echo = wait_for_type(&mut watching, "message.created").await;
    assert_eq!(echo["payload"]["body"], "bienvenue");

    // And an administrator taking her back out reaches her own session as the notice, on the same
    // socket, without her having to reload anything.
    app.req(
        reqwest::Method::DELETE,
        &format!(
            "/api/v1/channels/{}/members/{}",
            fx.public_channel, fx.carol
        ),
        &alice,
    )
    .send()
    .await
    .expect("remove");
    let removed = wait_for_type(&mut watching, "message.created").await;
    assert_eq!(removed["payload"]["system_event"], "channel_removed");
}

#[tokio::test]
async fn a_demoted_member_loses_the_space_in_the_same_breath() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let mut bobs = app.connect_ws(&bob).await;

    // A second public channel, which Bob is not in. He reads it anyway, as any member may.
    let elsewhere = make_channel(&app.db, fx.space_id, "ailleurs", "public").await;
    assert_eq!(
        status_of(
            &app,
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{elsewhere}/messages"),
            &bob
        )
        .await,
        200
    );

    // Demoted to guest: his own session is told, which is what lets the client re-read a space whose
    // contents the server has just narrowed under him.
    let changed = status_of_json(
        &app,
        reqwest::Method::PATCH,
        &format!("/api/v1/spaces/{}/members/{}", fx.space_id, fx.bob),
        &alice,
        json!({ "role": "guest" }),
    )
    .await;
    assert_eq!(changed, 200);
    let frame = wait_for_type(&mut bobs, "member.role_changed").await;
    assert_eq!(frame["payload"]["user_id"], fx.bob.to_string());
    assert_eq!(frame["payload"]["role"], "guest");

    // And the narrowing is real, not only announced: what he was never put in is gone...
    assert_eq!(
        status_of(
            &app,
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{elsewhere}/messages"),
            &bob
        )
        .await,
        403
    );
    // ...while the channel somebody did put him in stays his, which is the whole of the rule.
    assert_eq!(
        status_of(
            &app,
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &bob
        )
        .await,
        200
    );
    let channels: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &bob,
        )
        .send()
        .await
        .expect("channels")
        .json()
        .await
        .expect("json");
    let names: Vec<&str> = channels
        .as_array()
        .expect("array")
        .iter()
        .map(|c| c["name"].as_str().expect("name"))
        .collect();
    assert_eq!(names, vec!["general"]);
}

#[tokio::test]
async fn a_demotion_takes_back_a_channel_role_too() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    promote_to_admin(&app.db, fx.space_id, fx.alice).await;

    // Alice opens a channel, so she owns it, and may run it.
    let channel: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &alice,
        )
        .json(&json!({ "name": format!("atelier-{}", Uuid::new_v4().simple()), "type": "public" }))
        .send()
        .await
        .expect("create")
        .json()
        .await
        .expect("json");
    let channel_id = channel["id"].as_str().expect("id").to_owned();
    assert_eq!(
        status_of_json(
            &app,
            reqwest::Method::POST,
            &format!("/api/v1/channels/{channel_id}/members"),
            &alice,
            json!({ "user_ids": [fx.bob] })
        )
        .await,
        200
    );

    // Made a guest of the space, she keeps the channel she is in and loses the running of it: the
    // `owner` row in that channel does not survive the demotion, or a visitor would go on
    // administering a room in a space that is no longer theirs.
    make_guest(&app.db, fx.space_id, fx.alice).await;
    assert_eq!(
        status_of(
            &app,
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{channel_id}/messages"),
            &alice
        )
        .await,
        200,
        "she was put in it, so it stays hers to read"
    );
    for (method, path, body) in [
        (
            reqwest::Method::POST,
            format!("/api/v1/channels/{channel_id}/members"),
            Some(json!({ "user_ids": [fx.carol] })),
        ),
        (
            reqwest::Method::DELETE,
            format!("/api/v1/channels/{channel_id}/members/{}", fx.bob),
            None,
        ),
        (
            reqwest::Method::PATCH,
            format!("/api/v1/channels/{channel_id}"),
            Some(json!({ "name": "repris" })),
        ),
    ] {
        let status = match body {
            Some(json) => status_of_json(&app, method.clone(), &path, &alice, json).await,
            None => status_of(&app, method.clone(), &path, &alice).await,
        };
        assert_eq!(status, 403, "a guest moderates nothing: {method} {path}");
    }
}

#[tokio::test]
async fn a_pin_is_a_landmark_not_a_reading_right() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let carol = app.cookie_for(fx.carol).await;

    let sent: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &alice,
        )
        .json(&json!({ "body": "le plan" }))
        .send()
        .await
        .expect("send")
        .json()
        .await
        .expect("json");
    let message_id = sent["id"].as_str().expect("id").to_owned();
    let pin = format!("/api/v1/channels/{}/pins/{}", fx.public_channel, message_id);

    // Carol reads this public channel without being in it, which is allowed, and that is not a
    // reason to let her change what everyone else sees at the top of it.
    assert_eq!(
        status_of(&app, reqwest::Method::PUT, &pin, &carol).await,
        403,
        "reading a channel does not grant pinning in it"
    );

    // Alice is in it: she pins freely, because a channel where only moderators may pin is one where
    // nothing is ever pinned.
    assert_eq!(
        status_of(&app, reqwest::Method::PUT, &pin, &alice).await,
        204
    );

    // Bob is in it too, and it is not his pin to take down...
    assert_eq!(
        status_of(&app, reqwest::Method::DELETE, &pin, &bob).await,
        403,
        "somebody else's landmark is not yours to remove"
    );
    // ...while its author always may.
    assert_eq!(
        status_of(&app, reqwest::Method::DELETE, &pin, &alice).await,
        204
    );

    // And a moderator may take down anyone's.
    assert_eq!(
        status_of(&app, reqwest::Method::PUT, &pin, &alice).await,
        204
    );
    promote_to_admin(&app.db, fx.space_id, fx.bob).await;
    assert_eq!(
        status_of(&app, reqwest::Method::DELETE, &pin, &bob).await,
        204
    );

    // A guest never pins: taking part is one thing, changing what the whole channel sees is another.
    make_guest(&app.db, fx.space_id, fx.carol).await;
    add_channel_member(&app.db, fx.public_channel, fx.carol).await;
    assert_eq!(
        status_of(&app, reqwest::Method::PUT, &pin, &carol).await,
        403
    );
}

#[tokio::test]
async fn reacting_joins_the_channel_like_writing_does() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let carol = app.cookie_for(fx.carol).await;

    let sent: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/conversations/{}/messages", fx.public_channel),
            &alice,
        )
        .json(&json!({ "body": "le plan" }))
        .send()
        .await
        .expect("send")
        .json()
        .await
        .expect("json");
    let message_id = sent["id"].as_str().expect("id").to_owned();

    assert_eq!(
        status_of(
            &app,
            reqwest::Method::PUT,
            &format!("/api/v1/messages/{message_id}/reactions/%F0%9F%91%8D"),
            &carol
        )
        .await,
        204
    );
    // Same reason as writing: what a channel pushes goes to its members, so a reaction from someone
    // outside reached everyone but its own author.
    assert!(
        channel_members::Entity::find_by_id((fx.public_channel, fx.carol))
            .one(&app.db)
            .await
            .expect("membership")
            .is_some()
    );
}

// --- Claiming an account an import placed here ---------------------------------------------------
//
// An import creates accounts, puts them in their spaces and channels, and leaves them waiting: the
// history is here before the person is. Registering with the invitation addressed to them has to
// take over that account rather than collide with it, and must refuse every other shape, because
// what it hands over is an account with someone else's conversations already in it.

/// An account exactly as an import leaves one: placed, complete, never used.
async fn make_waiting_account(db: &DatabaseConnection, email: &str) -> Uuid {
    let id = Uuid::new_v4();
    users::ActiveModel {
        id: Set(id),
        email: Set(email.to_owned()),
        display_name: Set("Imported Name".to_owned()),
        password_hash: Set(None),
        status: Set("pending".to_owned()),
        mfa_enforced: Set(false),
        is_bot: Set(false),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("waiting account");
    id
}

/// An invitation row, addressed or not, returning the raw token.
async fn make_invitation(
    db: &DatabaseConnection,
    space_id: Uuid,
    created_by: Uuid,
    email: Option<&str>,
) -> String {
    let token = crate::auth::tokens::generate_token().expect("token");
    space_invitations::ActiveModel {
        id: Set(Uuid::new_v4()),
        space_id: Set(space_id),
        token_hash: Set(crate::auth::tokens::digest(&token)),
        email: Set(email.map(str::to_owned)),
        role: Set("member".to_owned()),
        created_by: Set(Some(created_by)),
        max_uses: Set(None),
        uses: Set(0),
        expires_at: Set(None),
        revoked_at: Set(None),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("invitation");
    token
}

async fn register(
    app: &TestApp,
    email: &str,
    name: &str,
    token: Option<&str>,
) -> reqwest::Response {
    let mut body = json!({
        "email": email,
        "display_name": name,
        "password": "un-mot-de-passe-bien-assez-long-42",
    });
    if let Some(token) = token {
        body["invitation_token"] = json!(token);
    }
    app.http
        .post(format!("{}/api/v1/auth/register", app.base))
        .json(&body)
        .send()
        .await
        .expect("register")
}

#[tokio::test]
async fn an_invitation_claims_the_account_the_import_left_waiting() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let email = format!("waiting-{}@example.test", Uuid::new_v4().simple());
    let waiting = make_waiting_account(&app.db, &email).await;
    let token = make_invitation(&app.db, fx.space_id, fx.alice, Some(&email)).await;

    let response = register(&app, &email, "Their Own Name", Some(&token)).await;

    // 200, not 201: nothing was created. The account and its history were already here.
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("json");
    assert_eq!(
        body["id"],
        waiting.to_string(),
        "the same account, not a second one"
    );

    let account = users::Entity::find_by_id(waiting)
        .one(&app.db)
        .await
        .expect("query")
        .expect("account");
    assert_eq!(account.status, "active");
    assert!(account.password_hash.is_some());
    // They are the person: the name they type wins over the one the source carried.
    assert_eq!(account.display_name, "Their Own Name");
}

#[tokio::test]
async fn a_shareable_link_cannot_claim_somebody_elses_account() {
    // The whole safety of this rests on the invitation being addressed. A link invitation carries
    // no address, so anyone holding one could otherwise type any address and take the account.
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let email = format!("waiting-{}@example.test", Uuid::new_v4().simple());
    make_waiting_account(&app.db, &email).await;
    let token = make_invitation(&app.db, fx.space_id, fx.alice, None).await;

    let response = register(&app, &email, "Intruder", Some(&token)).await;
    assert_eq!(response.status(), 409);
}

#[tokio::test]
async fn an_invitation_addressed_to_someone_else_cannot_claim_it() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let email = format!("waiting-{}@example.test", Uuid::new_v4().simple());
    make_waiting_account(&app.db, &email).await;
    let token = make_invitation(
        &app.db,
        fx.space_id,
        fx.alice,
        Some("elsewhere@example.test"),
    )
    .await;

    let response = register(&app, &email, "Intruder", Some(&token)).await;
    assert_eq!(response.status(), 409);
}

#[tokio::test]
async fn a_revoked_invitation_claims_nothing() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let email = format!("waiting-{}@example.test", Uuid::new_v4().simple());
    make_waiting_account(&app.db, &email).await;
    let token = make_invitation(&app.db, fx.space_id, fx.alice, Some(&email)).await;
    space_invitations::Entity::update_many()
        .col_expr(
            space_invitations::Column::RevokedAt,
            sea_orm::sea_query::Expr::value(Some(OffsetDateTime::now_utc())),
        )
        .filter(space_invitations::Column::TokenHash.eq(crate::auth::tokens::digest(&token)))
        .exec(&app.db)
        .await
        .expect("revoke");

    let response = register(&app, &email, "Too Late", Some(&token)).await;
    assert_eq!(response.status(), 409);
}

#[tokio::test]
async fn an_account_someone_already_uses_is_never_claimed() {
    // A password means a person set it. Even a correctly addressed invitation must not hand that
    // account to whoever holds the token.
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let email = format!("inuse-{}@example.test", Uuid::new_v4().simple());
    let account = make_waiting_account(&app.db, &email).await;
    let mut model: users::ActiveModel = users::Entity::find_by_id(account)
        .one(&app.db)
        .await
        .expect("query")
        .expect("account")
        .into();
    model.password_hash = Set(Some("already-set".to_owned()));
    model.status = Set("active".to_owned());
    model.update(&app.db).await.expect("update");

    let token = make_invitation(&app.db, fx.space_id, fx.alice, Some(&email)).await;
    let response = register(&app, &email, "Intruder", Some(&token)).await;
    assert_eq!(response.status(), 409);
}

#[tokio::test]
async fn registering_over_a_waiting_account_without_any_invitation_is_still_a_conflict() {
    let Some(app) = boot().await else { return };
    let _fx = seed(&app.db).await;
    let email = format!("waiting-{}@example.test", Uuid::new_v4().simple());
    make_waiting_account(&app.db, &email).await;

    let response = register(&app, &email, "Passer-by", None).await;
    assert_eq!(response.status(), 409);
}

// --- Writing what an import promised -------------------------------------------------------------
//
// The rule everything here checks: an entity and its mapping row are written together, so a second
// run recognises the first one's work instead of doing it again. Resuming and re-importing are the
// same mechanism, and these tests are how we know it.

use crate::importer::archive::{
    ChannelRecord, Index, Manifest, MemberStateRecord, SpaceRecord, UserRecord,
};
use crate::importer::plan::{self, Existing};
use crate::importer::run::{
    self, BlobSink, Mapper, KIND_CHANNEL, KIND_FILE, KIND_MESSAGE, KIND_SPACE, KIND_USER,
};

/// The thumbnail size the tests import at: the same default an instance ships with, since what is
/// being checked is that an imported image is treated like an uploaded one, not what size it ends
/// up.
const THUMBNAIL_MAX_PX: u32 = 512;

/// Where an import puts bytes in a test: in memory, with the instance's own thumbnail size, since
/// what is being checked is that an imported image is treated like an uploaded one.
fn blobs(sink: &MemorySink) -> run::Blobs<'_, MemorySink> {
    run::Blobs {
        store: sink,
        thumbnail_max_px: THUMBNAIL_MAX_PX,
    }
}

fn source_channel(id: &str, space: &str, kind: &str, members: &[&str]) -> ChannelRecord {
    ChannelRecord {
        id: id.into(),
        space: space.into(),
        kind: kind.into(),
        name: format!("Salon {id}"),
        topic: String::new(),
        visibility: "public".into(),
        archived: false,
        members: members.iter().map(|m| (*m).to_string()).collect(),
        member_state: vec![],
        created_at: None,
    }
}

fn import_index(users: Vec<UserRecord>, spaces: Vec<SpaceRecord>) -> Index {
    Index {
        manifest: Some(Manifest {
            format_version: 1,
            source: "mattermost".into(),
            source_version: String::new(),
            producer: "test".into(),
            created_at: String::new(),
            counts: Default::default(),
            checksums: Default::default(),
            limits: vec![],
        }),
        users,
        spaces,
        ..Default::default()
    }
}

/// Source identifiers have to differ between tests: a mapping is deliberately global, so that a
/// rehearsal import and the real one a week later recognise each other. Two tests both calling a
/// space "atelier" would be two runs of the same import, which is exactly what the feature says.
fn unique_ref(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::new_v4().simple())
}

fn source_user(id: &str, email: &str) -> UserRecord {
    UserRecord {
        id: id.into(),
        email: email.into(),
        display_name: format!("{id} from elsewhere"),
        active: true,
    }
}

fn source_space(id: &str, name: &str) -> SpaceRecord {
    SpaceRecord {
        id: id.into(),
        name: name.into(),
        description: String::new(),
        visibility: "private".into(),
    }
}

#[tokio::test]
async fn an_unknown_account_arrives_waiting_for_its_person() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let email = format!("newcomer-{}@example.test", Uuid::new_v4().simple());
    let index = import_index(vec![source_user(&unique_ref("alice"), &email)], vec![]);
    let plan = plan::build(&index, &Existing::default());

    let job = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");
    let written = run::import_accounts(&app.db, &mapper, &plan)
        .await
        .expect("accounts");

    assert_eq!(written.accounts_created, 1);
    let created = users::Entity::find()
        .filter(users::Column::Email.eq(email.clone()))
        .one(&app.db)
        .await
        .expect("query")
        .expect("account");
    // Waiting, not broken: pending with no password is exactly the shape an invitation claims.
    assert_eq!(created.status, "pending");
    assert!(created.password_hash.is_none());
    assert!(created.display_name.ends_with("from elsewhere"));
}

#[tokio::test]
async fn an_address_already_here_is_the_same_person_and_is_left_alone() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let existing_account = users::Entity::find_by_id(fx.bob)
        .one(&app.db)
        .await
        .expect("query")
        .expect("bob");

    let bob_ref = unique_ref("bob");
    let index = import_index(vec![source_user(&bob_ref, &existing_account.email)], vec![]);
    let plan = plan::build(
        &index,
        &Existing {
            emails: vec![existing_account.email.clone()],
            ..Default::default()
        },
    );

    let job = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");
    let written = run::import_accounts(&app.db, &mapper, &plan)
        .await
        .expect("accounts");

    assert_eq!(written.accounts_matched, 1);
    assert_eq!(written.accounts_created, 0);
    // An import does not get to rename people.
    let after = users::Entity::find_by_id(fx.bob)
        .one(&app.db)
        .await
        .expect("query")
        .expect("bob");
    assert_eq!(after.display_name, existing_account.display_name);
    assert_eq!(
        mapper
            .resolve(&app.db, KIND_USER, &bob_ref, None)
            .await
            .expect("resolve"),
        Some(fx.bob)
    );
}

#[tokio::test]
async fn an_account_with_no_address_still_arrives_and_can_be_told_apart() {
    // Six out of six in the Nextcloud fixture. They must land, because their messages have to be
    // attributed to a person, and they must not collide with each other.
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let (carol_ref, david_ref) = (unique_ref("carol"), unique_ref("david"));
    let index = import_index(
        vec![source_user(&carol_ref, ""), source_user(&david_ref, "")],
        vec![],
    );
    let plan = plan::build(&index, &Existing::default());

    let job = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");
    let written = run::import_accounts(&app.db, &mapper, &plan)
        .await
        .expect("accounts");

    assert_eq!(written.accounts_created, 2);
    let carol = mapper
        .resolve(&app.db, KIND_USER, &carol_ref, None)
        .await
        .expect("resolve");
    let david = mapper
        .resolve(&app.db, KIND_USER, &david_ref, None)
        .await
        .expect("resolve");
    assert!(carol.is_some() && david.is_some());
    assert_ne!(
        carol, david,
        "two people without an address are still two people"
    );
}

/// A resumed import shows its progress over everything it went through, not only what it wrote.
///
/// Found on the production instance: an import resumed after a failure recognised almost all of the
/// archive, wrote almost nothing, and its screen stood at zero on every pass until it jumped to
/// "done" - and said "0 accounts" at the end, the accounts all belonging to the first job.
#[tokio::test]
async fn a_resumed_import_counts_what_it_recognised() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let email = format!("resumed-{}@example.test", Uuid::new_v4().simple());
    let index = import_index(
        vec![
            source_user(&unique_ref("alice"), &email),
            source_user(&unique_ref("bob"), &format!("b-{email}")),
        ],
        vec![source_space(
            &unique_ref("atelier"),
            &format!("Atelier {}", Uuid::new_v4().simple()),
        )],
    );
    let plan = plan::build(&index, &Existing::default());

    let first = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let written = run::import_accounts(&app.db, &Mapper::new(first, "mattermost"), &plan)
        .await
        .expect("accounts");
    assert_eq!(written.accounts_created, 2);
    run::finish_job(&app.db, first, "failed")
        .await
        .expect("finish");

    // The resume is a job of its own, as it is when the screen starts one.
    let second = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(second, "mattermost");
    mapper.preload(&app.db).await.expect("preload");
    let again = run::import_accounts(&app.db, &mapper, &plan)
        .await
        .expect("accounts");
    assert_eq!(again.accounts_created, 0, "nothing written twice");
    assert_eq!(again.accounts_seen, 2, "and both counted as gone through");

    run::finish_job(&app.db, second, "completed")
        .await
        .expect("finish");
    let row = crate::entities::import_jobs::Entity::find_by_id(second)
        .one(&app.db)
        .await
        .expect("query")
        .expect("job");
    assert_eq!(
        row.accounts_done, 2,
        "what the screen reads, and closing the job must not take it back to zero"
    );
}

#[tokio::test]
async fn running_the_same_import_twice_creates_nothing_twice() {
    // The whole safety property: this is resumption and re-import at once.
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let email = format!("twice-{}@example.test", Uuid::new_v4().simple());
    let name = format!("Atelier {}", Uuid::new_v4().simple());
    let index = import_index(
        vec![source_user(&unique_ref("alice"), &email)],
        vec![source_space(&unique_ref("atelier"), &name)],
    );
    let plan = plan::build(&index, &Existing::default());

    let job = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");

    let first_accounts = run::import_accounts(&app.db, &mapper, &plan)
        .await
        .expect("accounts");
    let (first_spaces, _) = run::import_spaces(&app.db, &mapper, &index, fx.alice)
        .await
        .expect("spaces");
    assert_eq!(first_accounts.accounts_created, 1);
    assert_eq!(first_spaces.spaces_created, 1);

    // Same archive, same job, second run: everything is recognised.
    let second_accounts = run::import_accounts(&app.db, &mapper, &plan)
        .await
        .expect("accounts");
    let (second_spaces, _) = run::import_spaces(&app.db, &mapper, &index, fx.alice)
        .await
        .expect("spaces");
    assert_eq!(second_accounts.accounts_created, 0);
    assert_eq!(second_spaces.spaces_created, 0);
    assert_eq!(
        second_spaces.spaces_filled, 0,
        "recognised through its mapping, not re-found by name"
    );

    assert_eq!(
        users::Entity::find()
            .filter(users::Column::Email.eq(email))
            .count(&app.db)
            .await
            .expect("count"),
        1
    );
    assert_eq!(
        spaces::Entity::find()
            .filter(spaces::Column::Name.eq(name))
            .count(&app.db)
            .await
            .expect("count"),
        1
    );
    assert_eq!(
        import_mappings::Entity::find()
            .filter(import_mappings::Column::JobId.eq(job))
            .count(&app.db)
            .await
            .expect("count"),
        2,
        "one mapping per entity, not one per run"
    );
}

#[tokio::test]
async fn a_created_space_belongs_to_the_administrator_who_imported_it() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let name = format!("Reprise {}", Uuid::new_v4().simple());
    let index = import_index(vec![], vec![source_space(&unique_ref("atelier"), &name)]);

    let job = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");
    let (written, resolved) = run::import_spaces(&app.db, &mapper, &index, fx.alice)
        .await
        .expect("spaces");

    assert_eq!(written.spaces_created, 1);
    let (_, space_id) = resolved.first().expect("one space");
    let membership = space_members::Entity::find_by_id((*space_id, fx.alice))
        .one(&app.db)
        .await
        .expect("query")
        .expect("membership");
    assert_eq!(membership.role, "owner");

    // An imported space holds exactly what the archive carried: no starter channel nobody asked for.
    assert_eq!(
        conversations::Entity::find()
            .filter(conversations::Column::SpaceId.eq(*space_id))
            .count(&app.db)
            .await
            .expect("count"),
        0
    );
}

#[tokio::test]
async fn a_space_that_already_carries_the_name_is_filled_rather_than_duplicated() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    // A name of its own: the seed calls every space "Test Space", and several spaces sharing one
    // name is precisely the case the importer refuses to guess at.
    let name = format!("Espace {}", Uuid::new_v4().simple());
    let mut existing: spaces::ActiveModel = spaces::Entity::find_by_id(fx.space_id)
        .one(&app.db)
        .await
        .expect("query")
        .expect("space")
        .into();
    existing.name = Set(name.clone());
    existing.update(&app.db).await.expect("rename");
    let index = import_index(vec![], vec![source_space(&unique_ref("atelier"), &name)]);

    let job = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");
    let (written, resolved) = run::import_spaces(&app.db, &mapper, &index, fx.alice)
        .await
        .expect("spaces");

    assert_eq!(written.spaces_created, 0);
    assert_eq!(written.spaces_filled, 1);
    assert_eq!(resolved.first().expect("one space").1, fx.space_id);
}

#[tokio::test]
async fn closing_a_job_records_what_it_brought_in() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let index = import_index(
        vec![
            source_user(
                &unique_ref("a"),
                &format!("a-{}@example.test", Uuid::new_v4().simple()),
            ),
            source_user(
                &unique_ref("b"),
                &format!("b-{}@example.test", Uuid::new_v4().simple()),
            ),
        ],
        vec![],
    );
    let plan = plan::build(&index, &Existing::default());

    let job = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");
    run::import_accounts(&app.db, &mapper, &plan)
        .await
        .expect("accounts");
    run::finish_job(&app.db, job, "completed")
        .await
        .expect("finish");

    let row = crate::entities::import_jobs::Entity::find_by_id(job)
        .one(&app.db)
        .await
        .expect("query")
        .expect("job");
    assert_eq!(row.status, "completed");
    // Counted from the mappings, not from memory: a resumed run did part of its work elsewhere.
    assert_eq!(row.accounts_done, 2);
    assert!(row.finished_at.is_some());
    assert_eq!(
        run::written_so_far(&app.db, job, KIND_SPACE)
            .await
            .expect("count"),
        0
    );
}

/// The whole chain up to conversations, which is what every test below needs.
async fn import_up_to_conversations(
    app: &TestApp,
    admin: Uuid,
    index: &Index,
) -> (Uuid, Vec<(String, Uuid)>) {
    let plan = plan::build(index, &Existing::default());
    let job = run::start_job(&app.db, "mattermost", admin, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");
    run::import_accounts(&app.db, &mapper, &plan)
        .await
        .expect("accounts");
    let (_, spaces) = run::import_spaces(&app.db, &mapper, index, admin)
        .await
        .expect("spaces");
    run::import_conversations(&app.db, &mapper, index, &spaces, admin)
        .await
        .expect("conversations");
    (job, spaces)
}

#[tokio::test]
async fn a_channel_arrives_with_the_people_who_were_in_it() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let (one, two) = (unique_ref("alice"), unique_ref("bob"));
    let space_ref = unique_ref("atelier");
    let channel_ref = unique_ref("produit");
    let index = import_index(
        vec![
            source_user(&one, &format!("{one}@example.test")),
            source_user(&two, &format!("{two}@example.test")),
        ],
        vec![source_space(
            &space_ref,
            &format!("Espace {}", Uuid::new_v4().simple()),
        )],
    );
    let index = Index {
        channels: vec![source_channel(
            &channel_ref,
            &space_ref,
            "channel",
            &[&one, &two],
        )],
        ..index
    };

    let (job, spaces) = import_up_to_conversations(&app, fx.alice, &index).await;
    let mapper = Mapper::new(job, "mattermost");
    let space_id = spaces[0].1;
    let channel_id = mapper
        .resolve(&app.db, KIND_CHANNEL, &channel_ref, Some(space_id))
        .await
        .expect("resolve")
        .expect("channel");

    assert_eq!(
        channel_members::Entity::find()
            .filter(channel_members::Column::ChannelId.eq(channel_id))
            .count(&app.db)
            .await
            .expect("count"),
        2
    );
    // Being in a conversation means being in its space: forgetting this leaves people in rooms of
    // a workspace they are not part of.
    for source in [&one, &two] {
        let user = mapper
            .resolve(&app.db, KIND_USER, source, None)
            .await
            .expect("resolve")
            .expect("account");
        assert!(space_members::Entity::find_by_id((space_id, user))
            .one(&app.db)
            .await
            .expect("query")
            .is_some());
    }

    // Provenance on the row itself, readable without joining anything.
    let channel = channels::Entity::find_by_id(channel_id)
        .one(&app.db)
        .await
        .expect("query")
        .expect("channel");
    assert_eq!(channel.imported_source.as_deref(), Some("mattermost"));
    assert_eq!(channel.external_ref.as_deref(), Some(channel_ref.as_str()));
}

#[tokio::test]
async fn a_favourite_channel_stays_a_favourite() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let space_ref = unique_ref("atelier");
    let channel_ref = unique_ref("produit");
    let mut channel = source_channel(&channel_ref, &space_ref, "channel", &[&person]);
    channel.member_state = vec![MemberStateRecord {
        user: person.clone(),
        favorite: true,
        read_message: None,
        read_at: None,
    }];
    let index = Index {
        channels: vec![channel],
        ..import_index(
            vec![source_user(&person, &format!("{person}@example.test"))],
            vec![source_space(
                &space_ref,
                &format!("Espace {}", Uuid::new_v4().simple()),
            )],
        )
    };

    let (job, spaces) = import_up_to_conversations(&app, fx.alice, &index).await;
    let mapper = Mapper::new(job, "mattermost");
    let channel_id = mapper
        .resolve(&app.db, KIND_CHANNEL, &channel_ref, Some(spaces[0].1))
        .await
        .expect("resolve")
        .expect("channel");
    let user = mapper
        .resolve(&app.db, KIND_USER, &person, None)
        .await
        .expect("resolve")
        .expect("account");
    let membership = channel_members::Entity::find_by_id((channel_id, user))
        .one(&app.db)
        .await
        .expect("query")
        .expect("membership");
    assert!(membership.favorite);
}

#[tokio::test]
async fn an_archived_conversation_arrives_archived() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let space_ref = unique_ref("atelier");
    let channel_ref = unique_ref("ancien");
    let mut channel = source_channel(&channel_ref, &space_ref, "channel", &[]);
    channel.archived = true;
    let index = Index {
        channels: vec![channel],
        ..import_index(
            vec![],
            vec![source_space(
                &space_ref,
                &format!("Espace {}", Uuid::new_v4().simple()),
            )],
        )
    };

    let (job, spaces) = import_up_to_conversations(&app, fx.alice, &index).await;
    let mapper = Mapper::new(job, "mattermost");
    let channel_id = mapper
        .resolve(&app.db, KIND_CHANNEL, &channel_ref, Some(spaces[0].1))
        .await
        .expect("resolve")
        .expect("channel");
    let channel = channels::Entity::find_by_id(channel_id)
        .one(&app.db)
        .await
        .expect("query")
        .expect("channel");
    // Read-only here, which is the closest thing to what it was there.
    assert_eq!(channel.channel_type, "archived");
    assert!(channel.archived_at.is_some());
}

#[tokio::test]
async fn a_conversation_between_three_people_is_a_group() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let people: Vec<String> = (0..3).map(|i| unique_ref(&format!("p{i}"))).collect();
    let space_ref = unique_ref("atelier");
    let direct_ref = unique_ref("direct");
    let refs: Vec<&str> = people.iter().map(String::as_str).collect();
    let index = Index {
        channels: vec![source_channel(&direct_ref, &space_ref, "direct", &refs)],
        ..import_index(
            people
                .iter()
                .map(|p| source_user(p, &format!("{p}@example.test")))
                .collect(),
            vec![source_space(
                &space_ref,
                &format!("Espace {}", Uuid::new_v4().simple()),
            )],
        )
    };

    let (job, spaces) = import_up_to_conversations(&app, fx.alice, &index).await;
    let mapper = Mapper::new(job, "mattermost");
    let dm_id = mapper
        .resolve(&app.db, KIND_CHANNEL, &direct_ref, Some(spaces[0].1))
        .await
        .expect("resolve")
        .expect("dm");
    let dm = dm_conversations::Entity::find_by_id(dm_id)
        .one(&app.db)
        .await
        .expect("query")
        .expect("dm");
    assert!(dm.is_group);
    assert_eq!(
        dm_participants::Entity::find()
            .filter(dm_participants::Column::DmId.eq(dm_id))
            .count(&app.db)
            .await
            .expect("count"),
        3
    );
    // A direct conversation is not a channel: no channel row, no channel membership.
    assert!(channels::Entity::find_by_id(dm_id)
        .one(&app.db)
        .await
        .expect("query")
        .is_none());
}

/// A channel that is already here takes the archive's history instead of stopping the import.
///
/// Found in production: an instance whose first space was called "Atelier", with the `#general`
/// every space starts with, importing an archive carrying a space of the same name and a channel
/// of the same name. The space was adopted, as it should be, and then the channel could not be
/// created - a unique name per space - and the whole import died on a foreign constraint. Two
/// archives from two products meeting on `#general` is not an edge case, it is Tuesday.
#[tokio::test]
async fn a_channel_that_is_already_here_takes_the_history_rather_than_stopping_the_import() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let space_name = format!("Espace {}", Uuid::new_v4().simple());
    let shared = "Général";

    // First archive: creates the space and the channel.
    let first_space = unique_ref("atelier");
    let first_channel = unique_ref("general");
    let mut channel = source_channel(&first_channel, &first_space, "channel", &[]);
    channel.name = shared.to_owned();
    let first = Index {
        channels: vec![channel],
        ..import_index(vec![], vec![source_space(&first_space, &space_name)])
    };
    let (_, spaces) = import_up_to_conversations(&app, fx.alice, &first).await;
    let space_id = spaces[0].1;

    // Second archive, another product, same space name and same channel name. Nothing links the
    // two: different identifiers, different source, so no correspondence can be recognised.
    let second_space = unique_ref("atelier");
    let second_channel = unique_ref("general");
    let mut channel = source_channel(&second_channel, &second_space, "channel", &[]);
    channel.name = shared.to_owned();
    let second = Index {
        channels: vec![channel],
        ..import_index(vec![], vec![source_space(&second_space, &space_name)])
    };

    let job = run::start_job(&app.db, "slack", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "slack");
    let (spaces_written, resolved) = run::import_spaces(&app.db, &mapper, &second, fx.alice)
        .await
        .expect("spaces");
    assert_eq!(spaces_written.spaces_filled, 1, "the space was adopted");
    assert_eq!(resolved[0].1, space_id);

    let written = run::import_conversations(&app.db, &mapper, &second, &resolved, fx.alice)
        .await
        .expect("the import no longer stops on a name that is already here");

    assert_eq!(written.conversations_filled, 1);
    assert_eq!(written.conversations_created, 0);
    // One channel, not two under two spellings, and it is the one that was already here.
    assert_eq!(
        channels::Entity::find()
            .filter(channels::Column::SpaceId.eq(space_id))
            .filter(channels::Column::Name.eq("general"))
            .count(&app.db)
            .await
            .expect("count"),
        1
    );
    let adopted = mapper
        .resolve(&app.db, KIND_CHANNEL, &second_channel, Some(space_id))
        .await
        .expect("resolve")
        .expect("the second archive's channel points somewhere");
    let first_mapper = Mapper::new(job, "mattermost");
    let before = first_mapper
        .resolve(&app.db, KIND_CHANNEL, &first_channel, Some(space_id))
        .await
        .expect("resolve")
        .expect("the first archive's channel");
    assert_eq!(adopted, before, "both archives now point at the same room");
}

/// Two conversations of one archive whose names come down to the same handle stay two rooms.
///
/// The other side of adoption, and the reason it asks rather than just looking the name up:
/// "Café" and "cafe" are one handle here but two rooms there, and merging them would mix two
/// histories that nobody could separate again.
#[tokio::test]
async fn two_conversations_of_one_archive_that_share_a_handle_stay_two() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let space_ref = unique_ref("atelier");
    let (one, two) = (unique_ref("cafe"), unique_ref("cafe"));
    let mut first = source_channel(&one, &space_ref, "channel", &[]);
    first.name = "Café".to_owned();
    let mut second = source_channel(&two, &space_ref, "channel", &[]);
    second.name = "cafe".to_owned();
    let index = Index {
        channels: vec![first, second],
        ..import_index(
            vec![],
            vec![source_space(
                &space_ref,
                &format!("Espace {}", Uuid::new_v4().simple()),
            )],
        )
    };

    let (job, spaces) = import_up_to_conversations(&app, fx.alice, &index).await;
    let mapper = Mapper::new(job, "mattermost");
    let space_id = spaces[0].1;

    let mut names = Vec::new();
    for source_id in [&one, &two] {
        let id = mapper
            .resolve(&app.db, KIND_CHANNEL, source_id, Some(space_id))
            .await
            .expect("resolve")
            .expect("channel");
        names.push(
            channels::Entity::find_by_id(id)
                .one(&app.db)
                .await
                .expect("query")
                .expect("channel")
                .name,
        );
    }
    names.sort();
    assert_eq!(names, vec!["cafe".to_owned(), "cafe-2".to_owned()]);
}

#[tokio::test]
async fn importing_the_conversations_twice_creates_nothing_twice() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let space_ref = unique_ref("atelier");
    let channel_ref = unique_ref("produit");
    let index = Index {
        channels: vec![source_channel(
            &channel_ref,
            &space_ref,
            "channel",
            &[&person],
        )],
        ..import_index(
            vec![source_user(&person, &format!("{person}@example.test"))],
            vec![source_space(
                &space_ref,
                &format!("Espace {}", Uuid::new_v4().simple()),
            )],
        )
    };

    let (job, spaces) = import_up_to_conversations(&app, fx.alice, &index).await;
    let mapper = Mapper::new(job, "mattermost");
    let again = run::import_conversations(&app.db, &mapper, &index, &spaces, fx.alice)
        .await
        .expect("second run");

    assert_eq!(again.conversations_created, 0);
    assert_eq!(
        conversations::Entity::find()
            .filter(conversations::Column::SpaceId.eq(spaces[0].1))
            .count(&app.db)
            .await
            .expect("count"),
        1
    );
}

/// An administrator can give an address to somebody the export carried without one.
///
/// The common case on a real migration: the source had no address for a person, so nothing could
/// be matched and no invitation could be sent, and the administrator is the only one who knows who
/// they are. The account is created with the address they typed.
#[tokio::test]
async fn an_address_given_by_hand_reaches_the_account_that_is_created() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let index = import_index(vec![source_user(&person, "")], vec![]);

    let existing = Existing::default();
    let mut plan = plan::build(&index, &existing);
    let given = format!("{person}@given-by-hand.test");
    plan::apply_choices(
        &mut plan,
        &[plan::PersonChoice {
            source_id: person.clone(),
            email: Some(given.clone()),
            skip: false,
        }],
        &existing,
    );

    let job = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");
    run::import_accounts(&app.db, &mapper, &plan)
        .await
        .expect("accounts");

    let user_id = mapper
        .resolve(&app.db, KIND_USER, &person, None)
        .await
        .expect("resolve")
        .expect("the account should have been created");
    let user = crate::entities::users::Entity::find_by_id(user_id)
        .one(&app.db)
        .await
        .expect("query")
        .expect("account");
    assert_eq!(user.email, given);
}

/// Somebody left out gets no account, and their messages arrive anyway.
///
/// The decision is about people, not about text: dropping what they wrote as well would be the
/// silent loss this whole chain exists to prevent, and the interface already draws a message whose
/// author is absent.
#[tokio::test]
async fn somebody_left_out_gets_no_account_and_their_messages_still_arrive() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let dir = write_archive(
        &[
            json!({"id": space_ref, "name": format!("Espace {}", Uuid::new_v4().simple()),
                 "visibility": "private"}),
        ],
        &[
            json!({"id": person, "email": format!("{person}@example.test"),
                 "display_name": "Alice", "active": true}),
        ],
        &[
            json!({"id": channel_ref, "space": space_ref, "kind": "channel", "name": "Produit",
                 "visibility": "public", "archived": false, "members": [person]}),
        ],
        &[message_row(
            "m1",
            &channel_ref,
            Some(&person),
            "ce que j'ai écrit reste",
        )],
    );

    let index = crate::importer::archive::index(&dir, None).expect("index");
    let existing = Existing::default();
    let mut plan = plan::build(&index, &existing);
    plan::apply_choices(
        &mut plan,
        &[plan::PersonChoice {
            source_id: person.clone(),
            email: None,
            skip: true,
        }],
        &existing,
    );

    let job = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");
    run::import_accounts(&app.db, &mapper, &plan)
        .await
        .expect("accounts");
    let (_, spaces) = run::import_spaces(&app.db, &mapper, &index, fx.alice)
        .await
        .expect("spaces");
    run::import_conversations(&app.db, &mapper, &index, &spaces, fx.alice)
        .await
        .expect("conversations");
    run::import_messages(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("messages");

    assert!(
        mapper
            .resolve(&app.db, KIND_USER, &person, None)
            .await
            .expect("resolve")
            .is_none(),
        "no account should have been created for somebody left out"
    );

    let message_id = mapper
        .resolve(&app.db, KIND_MESSAGE, "m1", Some(spaces[0].1))
        .await
        .expect("resolve")
        .expect("the message should have arrived");
    let message = crate::entities::messages::Entity::find_by_id(message_id)
        .one(&app.db)
        .await
        .expect("query")
        .expect("message");
    assert_eq!(message.body, "ce que j'ai écrit reste");
    assert!(message.author_id.is_none(), "it arrives with no author");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_member_whose_account_was_skipped_is_left_out_rather_than_invented() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let space_ref = unique_ref("atelier");
    let channel_ref = unique_ref("produit");
    // The conversation names someone the archive never described: the accounts pass cannot have
    // mapped them, and putting a stranger in the room would be worse than leaving them out.
    let index = Index {
        channels: vec![source_channel(
            &channel_ref,
            &space_ref,
            "channel",
            &[&person, "ghost"],
        )],
        ..import_index(
            vec![source_user(&person, &format!("{person}@example.test"))],
            vec![source_space(
                &space_ref,
                &format!("Espace {}", Uuid::new_v4().simple()),
            )],
        )
    };

    let (job, spaces) = import_up_to_conversations(&app, fx.alice, &index).await;
    let mapper = Mapper::new(job, "mattermost");
    let channel_id = mapper
        .resolve(&app.db, KIND_CHANNEL, &channel_ref, Some(spaces[0].1))
        .await
        .expect("resolve")
        .expect("channel");
    assert_eq!(
        channel_members::Entity::find()
            .filter(channel_members::Column::ChannelId.eq(channel_id))
            .count(&app.db)
            .await
            .expect("count"),
        1
    );
}

// --- Messages ------------------------------------------------------------------------------------
//
// The messages are read from an archive on disk rather than from anything held in memory, so these
// tests write a small unpacked one and point the import at it. The reader takes a directory, which
// is what a producer writes before sealing.

/// Writes a minimal archive and returns its directory. Cleaned up by the caller's temp dir.
fn write_archive(
    spaces: &[Value],
    users: &[Value],
    channels: &[Value],
    messages: &[Value],
) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ruchoir-import-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).expect("archive dir");

    let write = |name: &str, rows: &[Value]| {
        let body: String = rows
            .iter()
            .map(|row| format!("{row}\n"))
            .collect::<Vec<_>>()
            .concat();
        std::fs::write(dir.join(name), body).expect("write");
    };
    write("spaces.jsonl", spaces);
    write("users.jsonl", users);
    write("channels.jsonl", channels);
    write("messages.jsonl", messages);
    write("files.jsonl", &[]);

    std::fs::write(
        dir.join("manifest.json"),
        json!({
            "format_version": 1,
            "source": "mattermost",
            "producer": "test",
            "created_at": "2026-09-13T10:00:00Z",
            "limits": ["nothing in particular"],
        })
        .to_string(),
    )
    .expect("manifest");
    dir
}

fn message_row(id: &str, channel: &str, author: Option<&str>, body: &str) -> Value {
    json!({
        "id": id,
        "channel": channel,
        "author": author,
        // Deliberately not today: an import that stamped everything with the time of the import
        // would otherwise pass, which is exactly what happened when this assertion said "today".
        "sent_at": "2024-03-05T08:09:10Z",
        "body": body,
        "format": "markdown",
        "thread_root": null,
        "pinned": false,
        "edited_at": null,
        "reactions": [],
        "saved_by": [],
        "files": [],
    })
}

/// Runs accounts, spaces and conversations from an archive on disk, and hands back what the
/// messages pass needs.
async fn import_from_archive(
    app: &TestApp,
    admin: Uuid,
    dir: &std::path::Path,
) -> (Uuid, Vec<(String, Uuid)>) {
    let index = crate::importer::archive::index(dir, None).expect("index");
    let plan = plan::build(&index, &Existing::default());
    let job = run::start_job(&app.db, "mattermost", admin, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");
    run::import_accounts(&app.db, &mapper, &plan)
        .await
        .expect("accounts");
    let (_, spaces) = run::import_spaces(&app.db, &mapper, &index, admin)
        .await
        .expect("spaces");
    run::import_conversations(&app.db, &mapper, &index, &spaces, admin)
        .await
        .expect("conversations");
    (job, spaces)
}

#[tokio::test]
async fn messages_arrive_with_their_text_author_and_time() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let dir = write_archive(
        &[
            json!({"id": space_ref, "name": format!("Espace {}", Uuid::new_v4().simple()), "visibility": "private"}),
        ],
        &[
            json!({"id": person, "email": format!("{person}@example.test"), "display_name": "Alice", "active": true}),
        ],
        &[
            json!({"id": channel_ref, "space": space_ref, "kind": "channel", "name": "Produit",
                 "visibility": "public", "archived": false, "members": [person]}),
        ],
        &[
            message_row("m1", &channel_ref, Some(&person), "bonjour"),
            json!({
                "id": "m2", "channel": channel_ref, "author": person,
                "sent_at": "2026-09-13T10:00:30Z", "body": "", "format": "markdown",
                "system_event": "channel_joined", "thread_root": null, "pinned": false,
                "edited_at": null, "reactions": [], "saved_by": [], "files": []
            }),
        ],
    );

    let (job, spaces) = import_from_archive(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    let written = run::import_messages(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("messages");
    assert_eq!(written.messages_created, 2);

    let conversation = mapper
        .resolve(&app.db, KIND_CHANNEL, &channel_ref, Some(spaces[0].1))
        .await
        .expect("resolve")
        .expect("conversation");
    let rows = messages::Entity::find()
        .filter(messages::Column::ConversationId.eq(conversation))
        .all(&app.db)
        .await
        .expect("messages");
    assert_eq!(rows.len(), 2);

    let ordinary = rows.iter().find(|m| m.kind == "message").expect("message");
    assert_eq!(ordinary.body, "bonjour");
    assert!(ordinary.author_id.is_some());
    assert_eq!(ordinary.imported_source.as_deref(), Some("mattermost"));
    // The time the message was sent there, not the time it was imported here.
    assert!(
        ordinary.created_at.to_string().starts_with("2024-03-05"),
        "kept the time it was sent, got {}",
        ordinary.created_at
    );

    // A notice carries an event and no sentence: the wording is ours, in the reader's language.
    let notice = rows.iter().find(|m| m.kind == "system").expect("notice");
    assert_eq!(notice.system_event.as_deref(), Some("channel_joined"));
    assert!(notice.body.is_empty());

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_reply_finds_its_root_even_when_it_comes_first_in_the_file() {
    // Resolved in a second pass on purpose: making the import depend on a producer's ordering
    // would make it break on a source nobody has written yet.
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let mut reply = message_row("reply", &channel_ref, Some(&person), "une réponse");
    reply["thread_root"] = json!("root");
    let dir = write_archive(
        &[
            json!({"id": space_ref, "name": format!("Espace {}", Uuid::new_v4().simple()), "visibility": "private"}),
        ],
        &[
            json!({"id": person, "email": format!("{person}@example.test"), "display_name": "Alice", "active": true}),
        ],
        &[
            json!({"id": channel_ref, "space": space_ref, "kind": "channel", "name": "Produit",
                 "visibility": "public", "archived": false, "members": [person]}),
        ],
        &[
            reply,
            message_row("root", &channel_ref, Some(&person), "la racine"),
        ],
    );

    let (job, spaces) = import_from_archive(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    run::import_messages(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("messages");

    let root_id = mapper
        .resolve(&app.db, KIND_MESSAGE, "root", Some(spaces[0].1))
        .await
        .expect("resolve")
        .expect("root");
    let reply_id = mapper
        .resolve(&app.db, KIND_MESSAGE, "reply", Some(spaces[0].1))
        .await
        .expect("resolve")
        .expect("reply");
    let reply_row = messages::Entity::find_by_id(reply_id)
        .one(&app.db)
        .await
        .expect("query")
        .expect("reply");
    assert_eq!(reply_row.parent_message_id, Some(root_id));
    let root_row = messages::Entity::find_by_id(root_id)
        .one(&app.db)
        .await
        .expect("query")
        .expect("root");
    assert_eq!(root_row.reply_count, 1);

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn what_people_did_with_a_message_comes_with_it() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let mut message = message_row("m1", &channel_ref, Some(&person), "épinglé");
    message["pinned"] = json!(true);
    message["reactions"] = json!([{"emoji": "tada", "by": [person]}]);
    message["saved_by"] = json!([person]);
    let dir = write_archive(
        &[
            json!({"id": space_ref, "name": format!("Espace {}", Uuid::new_v4().simple()), "visibility": "private"}),
        ],
        &[
            json!({"id": person, "email": format!("{person}@example.test"), "display_name": "Alice", "active": true}),
        ],
        &[
            json!({"id": channel_ref, "space": space_ref, "kind": "channel", "name": "Produit",
                 "visibility": "public", "archived": false, "members": [person]}),
        ],
        &[message],
    );

    let (job, spaces) = import_from_archive(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    run::import_messages(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("messages");

    let message_id = mapper
        .resolve(&app.db, KIND_MESSAGE, "m1", Some(spaces[0].1))
        .await
        .expect("resolve")
        .expect("message");
    assert_eq!(
        message_reactions::Entity::find()
            .filter(message_reactions::Column::MessageId.eq(message_id))
            .count(&app.db)
            .await
            .expect("count"),
        1
    );
    assert_eq!(
        user_saved_messages::Entity::find()
            .filter(user_saved_messages::Column::MessageId.eq(message_id))
            .count(&app.db)
            .await
            .expect("count"),
        1
    );
    assert_eq!(
        channel_pins::Entity::find()
            .filter(channel_pins::Column::MessageId.eq(message_id))
            .count(&app.db)
            .await
            .expect("count"),
        1
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_message_from_someone_we_could_not_place_keeps_its_text() {
    // The silent loss this whole chain exists to prevent: a guest, a bot, an account left behind.
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let dir = write_archive(
        &[
            json!({"id": space_ref, "name": format!("Espace {}", Uuid::new_v4().simple()), "visibility": "private"}),
        ],
        &[],
        &[
            json!({"id": channel_ref, "space": space_ref, "kind": "channel", "name": "Produit",
                 "visibility": "public", "archived": false, "members": []}),
        ],
        &[message_row(
            "m1",
            &channel_ref,
            Some("guests:sample"),
            "un message d'invité",
        )],
    );

    let (job, spaces) = import_from_archive(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    run::import_messages(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("messages");

    let message_id = mapper
        .resolve(&app.db, KIND_MESSAGE, "m1", Some(spaces[0].1))
        .await
        .expect("resolve")
        .expect("message");
    let row = messages::Entity::find_by_id(message_id)
        .one(&app.db)
        .await
        .expect("query")
        .expect("message");
    assert_eq!(row.body, "un message d'invité");
    assert!(
        row.author_id.is_none(),
        "attributed to an absent author, not dropped"
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn importing_the_messages_twice_writes_them_once() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let dir = write_archive(
        &[
            json!({"id": space_ref, "name": format!("Espace {}", Uuid::new_v4().simple()), "visibility": "private"}),
        ],
        &[
            json!({"id": person, "email": format!("{person}@example.test"), "display_name": "Alice", "active": true}),
        ],
        &[
            json!({"id": channel_ref, "space": space_ref, "kind": "channel", "name": "Produit",
                 "visibility": "public", "archived": false, "members": [person]}),
        ],
        &[message_row(
            "m1",
            &channel_ref,
            Some(&person),
            "une seule fois",
        )],
    );

    let (job, spaces) = import_from_archive(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    let first = run::import_messages(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("first");
    let second = run::import_messages(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("second");

    assert_eq!(first.messages_created, 1);
    assert_eq!(second.messages_created, 0);
    let conversation = mapper
        .resolve(&app.db, KIND_CHANNEL, &channel_ref, Some(spaces[0].1))
        .await
        .expect("resolve")
        .expect("conversation");
    assert_eq!(
        messages::Entity::find()
            .filter(messages::Column::ConversationId.eq(conversation))
            .count(&app.db)
            .await
            .expect("count"),
        1
    );

    std::fs::remove_dir_all(&dir).ok();
}

// --- Where everyone had read up to ---------------------------------------------------------------

/// An archive with one channel, two messages and a per-member state, written to disk.
fn archive_with_positions(
    person: &str,
    space_ref: &str,
    channel_ref: &str,
    state: Value,
) -> std::path::PathBuf {
    let mut channel = json!({
        "id": channel_ref, "space": space_ref, "kind": "channel", "name": "Produit",
        "visibility": "public", "archived": false, "members": [person],
    });
    channel["member_state"] = json!([state]);

    let mut older = message_row("older", channel_ref, Some(person), "le premier");
    older["sent_at"] = json!("2024-03-05T08:00:00Z");
    let mut newer = message_row("newer", channel_ref, Some(person), "le dernier");
    newer["sent_at"] = json!("2024-03-05T09:00:00Z");

    write_archive(
        &[
            json!({"id": space_ref, "name": format!("Espace {}", Uuid::new_v4().simple()), "visibility": "private"}),
        ],
        &[
            json!({"id": person, "email": format!("{person}@example.test"), "display_name": "Alice", "active": true}),
        ],
        &[channel],
        &[older, newer],
    )
}

async fn import_everything(
    app: &TestApp,
    admin: Uuid,
    dir: &std::path::Path,
) -> (Uuid, Vec<(String, Uuid)>) {
    let (job, spaces) = import_from_archive(app, admin, dir).await;
    let mapper = Mapper::new(job, "mattermost");
    run::import_messages(&app.db, &mapper, dir, None, &spaces)
        .await
        .expect("messages");
    let index = crate::importer::archive::index(dir, None).expect("index");
    run::import_read_positions(&app.db, &mapper, &index, &spaces)
        .await
        .expect("positions");
    (job, spaces)
}

async fn cursor_of(app: &TestApp, conversation: Uuid, user: Uuid) -> Option<Uuid> {
    read_cursors::Entity::find_by_id((conversation, user))
        .one(&app.db)
        .await
        .expect("query")
        .and_then(|cursor| cursor.last_read_message_id)
}

#[tokio::test]
async fn a_position_naming_a_message_lands_on_that_message() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let dir = archive_with_positions(
        &person,
        &space_ref,
        &channel_ref,
        json!({"user": person, "read_message": "older"}),
    );

    let (job, spaces) = import_everything(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    let conversation = mapper
        .resolve(&app.db, KIND_CHANNEL, &channel_ref, Some(spaces[0].1))
        .await
        .expect("r")
        .expect("c");
    let user = mapper
        .resolve(&app.db, KIND_USER, &person, None)
        .await
        .expect("r")
        .expect("u");
    let older = mapper
        .resolve(&app.db, KIND_MESSAGE, "older", Some(spaces[0].1))
        .await
        .expect("r")
        .expect("m");

    assert_eq!(cursor_of(&app, conversation, user).await, Some(older));
    std::fs::remove_dir_all(&dir).ok();
}

/// Stopping an import must not hand somebody a workspace where everything is unread.
///
/// The reading positions are the last pass, so a run that stopped left every conversation it had
/// already imported showing as never read: thousands of unread messages in conversations the
/// person had finished with years ago somewhere else. Whoever stopped the import kept what was
/// written, which was the promise, and lost the one thing that made it usable.
#[tokio::test]
async fn an_import_that_was_stopped_still_leaves_the_reading_positions() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let dir = archive_with_positions(
        &person,
        &space_ref,
        &channel_ref,
        json!({"user": person, "read_message": "older"}),
    );

    // A first run brought the messages over. This is the ordinary shape of the failure: an import
    // stops after its messages and before its positions.
    let (job, spaces) = import_from_archive(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    run::import_messages(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("messages");

    let conversation = mapper
        .resolve(&app.db, KIND_CHANNEL, &channel_ref, Some(spaces[0].1))
        .await
        .expect("r")
        .expect("c");
    let user = mapper
        .resolve(&app.db, KIND_USER, &person, None)
        .await
        .expect("r")
        .expect("u");
    let older = mapper
        .resolve(&app.db, KIND_MESSAGE, "older", Some(spaces[0].1))
        .await
        .expect("r")
        .expect("m");
    assert_eq!(
        cursor_of(&app, conversation, user).await,
        None,
        "nothing should have read anything yet"
    );

    // Somebody presses stop, and the run is asked to leave.
    let model = crate::entities::import_jobs::Entity::find_by_id(job)
        .one(&app.db)
        .await
        .expect("query")
        .expect("job");
    let mut model: crate::entities::import_jobs::ActiveModel = model.into();
    model.status = sea_orm::ActiveValue::Set("cancelling".to_owned());
    model.update(&app.db).await.expect("ask to stop");

    crate::importer::job::execute_into(
        &app.db,
        Some(&MemorySink::default()),
        &dir,
        None,
        fx.alice,
        job,
        THUMBNAIL_MAX_PX,
    )
    .await
    .expect("the run leaves cleanly");

    let after = crate::entities::import_jobs::Entity::find_by_id(job)
        .one(&app.db)
        .await
        .expect("query")
        .expect("job");
    assert_eq!(after.status, "cancelled");
    assert_eq!(
        cursor_of(&app, conversation, user).await,
        Some(older),
        "what was imported before the stop should be as read as it was in the other product"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_position_that_only_knows_a_moment_lands_on_the_last_message_before_it() {
    // Mattermost knows an instant, not a message. The closest true statement is the last message
    // sent at or before it.
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let dir = archive_with_positions(
        &person,
        &space_ref,
        &channel_ref,
        json!({"user": person, "read_at": "2024-03-05T08:30:00Z"}),
    );

    let (job, spaces) = import_everything(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    let conversation = mapper
        .resolve(&app.db, KIND_CHANNEL, &channel_ref, Some(spaces[0].1))
        .await
        .expect("r")
        .expect("c");
    let user = mapper
        .resolve(&app.db, KIND_USER, &person, None)
        .await
        .expect("r")
        .expect("u");
    let older = mapper
        .resolve(&app.db, KIND_MESSAGE, "older", Some(spaces[0].1))
        .await
        .expect("r")
        .expect("m");
    let newer = mapper
        .resolve(&app.db, KIND_MESSAGE, "newer", Some(spaces[0].1))
        .await
        .expect("r")
        .expect("m");

    let cursor = cursor_of(&app, conversation, user).await;
    assert_eq!(
        cursor,
        Some(older),
        "the one before the moment, not the one after"
    );
    assert_ne!(cursor, Some(newer));
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_position_on_a_message_that_did_not_cross_falls_back_rather_than_vanishing() {
    // Declaring months of history unread because one identifier is missing is worse than being
    // slightly early.
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let dir = archive_with_positions(
        &person,
        &space_ref,
        &channel_ref,
        json!({"user": person, "read_message": "a-message-left-behind"}),
    );

    let (job, spaces) = import_everything(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    let conversation = mapper
        .resolve(&app.db, KIND_CHANNEL, &channel_ref, Some(spaces[0].1))
        .await
        .expect("r")
        .expect("c");
    let user = mapper
        .resolve(&app.db, KIND_USER, &person, None)
        .await
        .expect("r")
        .expect("u");

    assert!(cursor_of(&app, conversation, user).await.is_some());
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_favourite_alone_leaves_no_reading_position() {
    // Somebody who marked a channel as a favourite and never read it has no position to restore,
    // and inventing one would mark their history read on their behalf.
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let dir = archive_with_positions(
        &person,
        &space_ref,
        &channel_ref,
        json!({"user": person, "favorite": true}),
    );

    let (job, spaces) = import_everything(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    let conversation = mapper
        .resolve(&app.db, KIND_CHANNEL, &channel_ref, Some(spaces[0].1))
        .await
        .expect("r")
        .expect("c");
    let user = mapper
        .resolve(&app.db, KIND_USER, &person, None)
        .await
        .expect("r")
        .expect("u");

    assert!(cursor_of(&app, conversation, user).await.is_none());
    std::fs::remove_dir_all(&dir).ok();
}

// --- Files ---------------------------------------------------------------------------------------
//
// The only part of an import that leaves the database, and the only one that can fail for a reason
// nobody here controls. The ordering it rests on (bytes first, rows after) is only worth anything
// if the failure is tested, which is what the refusing sink below is for.

/// An object store that keeps what it is given, and can be told to refuse.
#[derive(Default)]
struct MemorySink {
    stored: std::sync::Mutex<Vec<(String, Vec<u8>)>>,
    refuse: bool,
}

impl BlobSink for MemorySink {
    async fn put(&self, key: &str, bytes: &[u8], _content_type: &str) -> Result<(), String> {
        if self.refuse {
            return Err("the store is unreachable".to_owned());
        }
        self.stored
            .lock()
            .expect("lock")
            .push((key.to_owned(), bytes.to_vec()));
        Ok(())
    }
}

/// An archive carrying one file, attached to one message.
fn archive_with_a_file(person: &str, space_ref: &str, channel_ref: &str) -> std::path::PathBuf {
    let content = b"le contenu du fichier";
    let digest = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(content);
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };

    let dir = write_archive(
        &[
            json!({"id": space_ref, "name": format!("Espace {}", Uuid::new_v4().simple()), "visibility": "private"}),
        ],
        &[
            json!({"id": person, "email": format!("{person}@example.test"), "display_name": "Alice", "active": true}),
        ],
        &[
            json!({"id": channel_ref, "space": space_ref, "kind": "channel", "name": "Produit",
                 "visibility": "public", "archived": false, "members": [person]}),
        ],
        &[{
            let mut message = message_row("m1", channel_ref, Some(person), "une pièce jointe");
            message["files"] = json!(["note.txt"]);
            message
        }],
    );

    std::fs::write(
        dir.join("files.jsonl"),
        format!(
            "{}\n",
            json!({
                "id": "note.txt", "name": "note.txt", "path": "note.txt",
                "size": content.len(), "content_type": "text/plain",
                "hash": format!("sha256:{digest}"),
                "uploaded_by": person, "uploaded_at": "2024-03-05T08:00:00Z",
            })
        ),
    )
    .expect("files.jsonl");

    let blob = dir.join("blobs").join(&digest[..2]);
    std::fs::create_dir_all(&blob).expect("blobs");
    std::fs::write(blob.join(&digest), content).expect("blob");
    dir
}

/// An imported image is previewable, like an uploaded one.
///
/// Reported from a migrated Slack workspace: a photograph that shows inline when uploaded here
/// arrived from the import as a grey file card with a download button. The product decides an
/// attachment is lookable at from its dimensions and its thumbnail, and the import wrote neither.
#[tokio::test]
async fn an_imported_image_arrives_with_its_dimensions_and_a_thumbnail() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));

    let picture = {
        let mut out = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(6, 4, image::Rgb([198, 93, 69]))
            .write_to(&mut out, image::ImageFormat::Png)
            .expect("encode");
        out.into_inner()
    };
    let dir = archive_with_a_blob(
        &person,
        &space_ref,
        &channel_ref,
        &picture,
        "image/png",
        "photo.png",
    );

    let (job, spaces) = import_from_archive(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    let sink = MemorySink::default();
    run::import_files(&app.db, &mapper, &blobs(&sink), &dir, None, &spaces)
        .await
        .expect("files");

    let file = files::Entity::find()
        .filter(files::Column::Name.eq("photo.png"))
        .one(&app.db)
        .await
        .expect("query")
        .expect("the image arrived");
    let version = file_versions::Entity::find_by_id(file.current_version_id.expect("a version"))
        .one(&app.db)
        .await
        .expect("query")
        .expect("the version");

    assert_eq!(version.image_width, Some(6));
    assert_eq!(version.image_height, Some(4));
    assert!(version.thumbnail_key.is_some(), "no thumbnail, no preview");
    // The kind the product reads to decide an attachment is lookable at, as an upload sets it.
    assert_eq!(file.kind, "image");
    // The bytes and the thumbnail, two objects rather than one.
    assert_eq!(sink.stored.lock().expect("lock").len(), 2);
}

/// The same archive as [`archive_with_a_file`], for bytes of any kind.
fn archive_with_a_blob(
    person: &str,
    space_ref: &str,
    channel_ref: &str,
    content: &[u8],
    content_type: &str,
    name: &str,
) -> std::path::PathBuf {
    let digest = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(content);
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };

    let dir = write_archive(
        &[
            json!({"id": space_ref, "name": format!("Espace {}", Uuid::new_v4().simple()), "visibility": "private"}),
        ],
        &[
            json!({"id": person, "email": format!("{person}@example.test"), "display_name": "Alice", "active": true}),
        ],
        &[
            json!({"id": channel_ref, "space": space_ref, "kind": "channel", "name": "Produit",
                 "visibility": "public", "archived": false, "members": [person]}),
        ],
        &[{
            let mut message = message_row("m1", channel_ref, Some(person), "une pièce jointe");
            message["files"] = json!([name]);
            message
        }],
    );

    std::fs::write(
        dir.join("files.jsonl"),
        format!(
            "{}\n",
            json!({
                "id": name, "name": name, "path": name,
                "size": content.len(), "content_type": content_type,
                "hash": format!("sha256:{digest}"),
                "uploaded_by": person, "uploaded_at": "2024-03-05T08:00:00Z",
            })
        ),
    )
    .expect("files.jsonl");

    let blob = dir.join("blobs").join(&digest[..2]);
    std::fs::create_dir_all(&blob).expect("blobs");
    std::fs::write(blob.join(&digest), content).expect("blob");
    dir
}

#[tokio::test]
async fn a_file_arrives_with_its_bytes_and_hangs_on_its_message() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let dir = archive_with_a_file(&person, &space_ref, &channel_ref);

    let (job, spaces) = import_from_archive(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    run::import_messages(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("messages");

    let sink = MemorySink::default();
    let written = run::import_files(&app.db, &mapper, &blobs(&sink), &dir, None, &spaces)
        .await
        .expect("files");
    run::attach_files(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("attach");

    assert_eq!(written.files_created, 1);
    let file_id = mapper
        .resolve(&app.db, KIND_FILE, "note.txt", Some(spaces[0].1))
        .await
        .expect("resolve")
        .expect("file");
    let file = files::Entity::find_by_id(file_id)
        .one(&app.db)
        .await
        .expect("query")
        .expect("file");
    assert_eq!(file.name, "note.txt");
    assert_eq!(file.size_bytes, 21);
    assert_eq!(file.imported_source.as_deref(), Some("mattermost"));
    // The file points at a version, and the version at the bytes that were actually stored.
    let version_id = file.current_version_id.expect("a current version");
    let version = file_versions::Entity::find_by_id(version_id)
        .one(&app.db)
        .await
        .expect("query")
        .expect("version");
    let key = version.storage_key.expect("a storage key");
    let (stored_key, stored_bytes) = {
        let stored = sink.stored.lock().expect("lock");
        assert_eq!(stored.len(), 1);
        stored[0].clone()
    };
    assert_eq!(
        stored_key, key,
        "the row points at the object that was written"
    );
    assert_eq!(stored_bytes, b"le contenu du fichier");

    let message_id = mapper
        .resolve(&app.db, KIND_MESSAGE, "m1", Some(spaces[0].1))
        .await
        .expect("resolve")
        .expect("message");
    let attachment = message_attachments::Entity::find_by_id((message_id, file_id))
        .one(&app.db)
        .await
        .expect("query")
        .expect("attachment");
    assert_eq!(attachment.file_version_id, Some(version_id));

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_store_that_refuses_leaves_no_file_that_cannot_be_opened() {
    // The whole reason the bytes are written before the rows. A row written first would survive the
    // failure and leave a file that has a name, a size, and nothing behind it.
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let dir = archive_with_a_file(&person, &space_ref, &channel_ref);

    let (job, spaces) = import_from_archive(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    let sink = MemorySink {
        refuse: true,
        ..Default::default()
    };

    let outcome = run::import_files(&app.db, &mapper, &blobs(&sink), &dir, None, &spaces).await;
    assert!(
        outcome.is_err(),
        "an import that cannot store bytes has to stop"
    );

    assert_eq!(
        files::Entity::find()
            .filter(files::Column::SpaceId.eq(spaces[0].1))
            .count(&app.db)
            .await
            .expect("count"),
        0,
        "no file row survives a storage failure"
    );
    // And the mapping is absent too, so a later run starts this file over rather than skipping it.
    assert!(mapper
        .resolve(&app.db, KIND_FILE, "note.txt", Some(spaces[0].1))
        .await
        .expect("resolve")
        .is_none());

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn importing_the_files_twice_stores_them_once() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let person = unique_ref("alice");
    let (space_ref, channel_ref) = (unique_ref("atelier"), unique_ref("produit"));
    let dir = archive_with_a_file(&person, &space_ref, &channel_ref);

    let (job, spaces) = import_from_archive(&app, fx.alice, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    run::import_messages(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("messages");

    let sink = MemorySink::default();
    let first = run::import_files(&app.db, &mapper, &blobs(&sink), &dir, None, &spaces)
        .await
        .expect("first");
    run::attach_files(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("attach");
    let second = run::import_files(&app.db, &mapper, &blobs(&sink), &dir, None, &spaces)
        .await
        .expect("second");
    run::attach_files(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("attach again");

    assert_eq!(first.files_created, 1);
    assert_eq!(second.files_created, 0);
    assert_eq!(
        sink.stored.lock().expect("lock").len(),
        1,
        "the bytes are written once"
    );
    assert!(
        message_attachments::Entity::find()
            .count(&app.db)
            .await
            .expect("count")
            > 0,
        "the attachment survives a second run"
    );

    std::fs::remove_dir_all(&dir).ok();
}

// --- Nothing leaks out of an imported space ------------------------------------------------------
//
// An import creates spaces, accounts and conversations wholesale, which makes it the easiest place
// in the product for an isolation defect to arrive unnoticed: nobody watches a space they did not
// know existed. These tests drive the real HTTP surface rather than the database, because a leak
// would be in the authorization layer and not in the rows.

/// Imports two spaces, each with a private channel and a direct conversation, and hands back the
/// identifiers a test needs to try to reach across them.
struct TwoSpaces {
    first_space: Uuid,
    second_space: Uuid,
    first_private: Uuid,
    second_private: Uuid,
    direct: Uuid,
    /// A member of the first space only.
    insider: Uuid,
    /// A member of the second space only.
    other_side: Uuid,
    dir: std::path::PathBuf,
}

async fn import_two_spaces(app: &TestApp, admin: Uuid) -> TwoSpaces {
    let (one, two) = (unique_ref("insider"), unique_ref("other"));
    let (space_a, space_b) = (unique_ref("alpha"), unique_ref("beta"));
    let (private_a, private_b) = (unique_ref("secret-a"), unique_ref("secret-b"));
    let direct_ref = unique_ref("direct");

    let dir = write_archive(
        &[
            json!({"id": space_a, "name": format!("Alpha {}", Uuid::new_v4().simple()), "visibility": "private"}),
            json!({"id": space_b, "name": format!("Beta {}", Uuid::new_v4().simple()), "visibility": "private"}),
        ],
        &[
            json!({"id": one, "email": format!("{one}@example.test"), "display_name": "Insider", "active": true}),
            json!({"id": two, "email": format!("{two}@example.test"), "display_name": "Other", "active": true}),
        ],
        &[
            json!({"id": private_a, "space": space_a, "kind": "channel", "name": "Cloison A",
                   "visibility": "private", "archived": false, "members": [one]}),
            json!({"id": private_b, "space": space_b, "kind": "channel", "name": "Cloison B",
                   "visibility": "private", "archived": false, "members": [two]}),
            json!({"id": direct_ref, "space": space_a, "kind": "direct", "name": "",
                   "visibility": "private", "archived": false, "members": [one, two]}),
        ],
        &[
            message_row(
                "secret-a",
                &private_a,
                Some(&one),
                "ce qui se dit chez alpha",
            ),
            message_row(
                "secret-b",
                &private_b,
                Some(&two),
                "ce qui se dit chez beta",
            ),
            message_row("secret-d", &direct_ref, Some(&one), "entre nous deux"),
        ],
    );

    let (job, spaces) = import_from_archive(app, admin, &dir).await;
    let mapper = Mapper::new(job, "mattermost");
    run::import_messages(&app.db, &mapper, &dir, None, &spaces)
        .await
        .expect("messages");

    let resolve_space =
        |source: &String| spaces.iter().find(|(id, _)| id == source).expect("space").1;
    TwoSpaces {
        first_space: resolve_space(&space_a),
        second_space: resolve_space(&space_b),
        first_private: mapper
            .resolve(
                &app.db,
                KIND_CHANNEL,
                &private_a,
                Some(resolve_space(&space_a)),
            )
            .await
            .expect("r")
            .expect("private a"),
        second_private: mapper
            .resolve(
                &app.db,
                KIND_CHANNEL,
                &private_b,
                Some(resolve_space(&space_b)),
            )
            .await
            .expect("r")
            .expect("private b"),
        direct: mapper
            .resolve(
                &app.db,
                KIND_CHANNEL,
                &direct_ref,
                Some(resolve_space(&space_a)),
            )
            .await
            .expect("r")
            .expect("direct"),
        insider: mapper
            .resolve(&app.db, KIND_USER, &one, None)
            .await
            .expect("r")
            .expect("insider"),
        other_side: mapper
            .resolve(&app.db, KIND_USER, &two, None)
            .await
            .expect("r")
            .expect("other"),
        dir,
    }
}

#[tokio::test]
async fn a_stranger_sees_none_of_an_imported_space() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let imported = import_two_spaces(&app, fx.alice).await;

    // Someone who has nothing to do with any of it.
    let stranger = make_user(&app.db, "stranger").await;
    let cookie = app.cookie_for(stranger).await;

    let spaces: Value = app
        .req(reqwest::Method::GET, "/api/v1/me/spaces", &cookie)
        .send()
        .await
        .expect("spaces")
        .json()
        .await
        .expect("json");
    let listed: Vec<String> = spaces
        .as_array()
        .expect("array")
        .iter()
        .map(|space| space["id"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert!(!listed.contains(&imported.first_space.to_string()));
    assert!(!listed.contains(&imported.second_space.to_string()));

    // Not by asking for the space's channels either.
    let channels = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/channels", imported.first_space),
            &cookie,
        )
        .send()
        .await
        .expect("channels");
    assert!(
        channels.status() == 404 || channels.status() == 403,
        "a stranger must not list an imported space's channels, got {}",
        channels.status()
    );

    // Nor by naming a conversation directly.
    for conversation in [imported.first_private, imported.direct] {
        let messages = app
            .req(
                reqwest::Method::GET,
                &format!("/api/v1/conversations/{conversation}/messages"),
                &cookie,
            )
            .send()
            .await
            .expect("messages");
        assert!(
            messages.status() == 404 || messages.status() == 403,
            "a stranger read an imported conversation, got {}",
            messages.status()
        );
    }

    std::fs::remove_dir_all(&imported.dir).ok();
}

#[tokio::test]
async fn a_member_of_one_imported_space_cannot_reach_the_other() {
    // The case a multi-space archive creates and a single-space one never would: two organisations
    // that were deliberately apart, imported in one go, must stay apart.
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let imported = import_two_spaces(&app, fx.alice).await;
    let cookie = app.cookie_for(imported.insider).await;

    let spaces: Value = app
        .req(reqwest::Method::GET, "/api/v1/me/spaces", &cookie)
        .send()
        .await
        .expect("spaces")
        .json()
        .await
        .expect("json");
    let listed: Vec<String> = spaces
        .as_array()
        .expect("array")
        .iter()
        .map(|space| space["id"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert!(
        listed.contains(&imported.first_space.to_string()),
        "their own space is there"
    );
    assert!(
        !listed.contains(&imported.second_space.to_string()),
        "the other organisation's space is not"
    );

    let messages = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{}/messages", imported.second_private),
            &cookie,
        )
        .send()
        .await
        .expect("messages");
    assert!(
        messages.status() == 404 || messages.status() == 403,
        "read across two imported spaces, got {}",
        messages.status()
    );

    std::fs::remove_dir_all(&imported.dir).ok();
}

#[tokio::test]
async fn an_imported_private_channel_stays_private_to_its_members() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let imported = import_two_spaces(&app, fx.alice).await;

    // The other side is already a member of the first space, and not because anybody put them
    // there: they share a direct conversation that lives in it, and being in a conversation means
    // being in its space. So the space is shared and the private room is not, which is exactly the
    // distinction an import must not blur.
    assert!(
        space_members::Entity::find_by_id((imported.first_space, imported.other_side))
            .one(&app.db)
            .await
            .expect("query")
            .is_some(),
        "the direct conversation put them in the space"
    );
    let cookie = app.cookie_for(imported.other_side).await;

    let channels: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/channels", imported.first_space),
            &cookie,
        )
        .send()
        .await
        .expect("channels")
        .json()
        .await
        .expect("json");
    let listed: Vec<String> = channels
        .as_array()
        .expect("array")
        .iter()
        .map(|channel| channel["id"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert!(
        !listed.contains(&imported.first_private.to_string()),
        "an imported private channel showed up to someone who is not in it"
    );

    let messages = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{}/messages", imported.first_private),
            &cookie,
        )
        .send()
        .await
        .expect("messages");
    assert!(
        messages.status() == 404 || messages.status() == 403,
        "read an imported private channel from outside, got {}",
        messages.status()
    );

    std::fs::remove_dir_all(&imported.dir).ok();
}

#[tokio::test]
async fn an_imported_direct_conversation_is_between_its_two_people_only() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let imported = import_two_spaces(&app, fx.alice).await;

    // Even the administrator who ran the import, and who owns the space, has no business in it.
    let cookie = app.cookie_for(fx.alice).await;
    let messages = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/conversations/{}/messages", imported.direct),
            &cookie,
        )
        .send()
        .await
        .expect("messages");
    assert!(
        messages.status() == 404 || messages.status() == 403,
        "the importing administrator read a direct conversation they imported, got {}",
        messages.status()
    );

    std::fs::remove_dir_all(&imported.dir).ok();
}

/// The people an import brought over survive the screen that started it.
///
/// An import of any size outlives the screen: the administrator closes it, comes back, and the
/// plan that named those people is gone. Without this they could no longer send the invitations,
/// which is the one thing left to do at the end.
#[tokio::test]
async fn the_people_an_import_brought_can_be_read_back_from_the_server() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let mut admin: users::ActiveModel = users::Entity::find_by_id(fx.alice)
        .one(&app.db)
        .await
        .expect("query")
        .expect("alice")
        .into();
    admin.is_instance_admin = Set(true);
    admin.update(&app.db).await.expect("promote");
    let cookie = app.cookie_for(fx.alice).await;

    let job = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    let mapper = Mapper::new(job, "mattermost");
    let zoe = make_user(&app.db, "Zoe Imported").await;
    let adam = make_user(&app.db, "Adam Imported").await;
    let zoe_ref = unique_ref("zoe");
    let adam_ref = unique_ref("adam");
    mapper
        .record(&app.db, KIND_USER, &zoe_ref, None, zoe)
        .await
        .expect("mapping");
    mapper
        .record(&app.db, KIND_USER, &adam_ref, None, adam)
        .await
        .expect("mapping");

    let response = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/imports/{job}/people"),
            &cookie,
        )
        .send()
        .await
        .expect("people");
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("json");
    let people = body.as_array().expect("a list");
    let ours: Vec<&Value> = people
        .iter()
        .filter(|person| {
            let id = person["source_id"].as_str().unwrap_or_default();
            id == zoe_ref || id == adam_ref
        })
        .collect();
    assert_eq!(
        ours.len(),
        2,
        "both, and read back by their source identifier"
    );
    assert_eq!(
        ours[0]["source_id"].as_str(),
        Some(adam_ref.as_str()),
        "ordered the way a list of people is read"
    );
    assert!(
        ours[0]["email"].as_str().unwrap_or_default().contains('@'),
        "with the address an invitation would go to"
    );
    assert_eq!(
        ours[0]["invited"],
        json!(false),
        "nobody has been written to"
    );

    // Somebody the archive carried without an address has one here, because the column demands it,
    // and it can receive nothing. It must read as an absence, or the screen offers to write to it.
    let nameless = Uuid::new_v4();
    users::ActiveModel {
        id: Set(nameless),
        email: Set(format!(
            "u404+{}{}",
            nameless.simple(),
            run::NO_ADDRESS_DOMAIN
        )),
        display_name: Set("Sans Adresse".to_owned()),
        password_hash: Set(None),
        status: Set("pending".to_owned()),
        mfa_enforced: Set(false),
        is_bot: Set(false),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("user");
    let nameless_ref = unique_ref("nameless");
    mapper
        .record(&app.db, KIND_USER, &nameless_ref, None, nameless)
        .await
        .expect("mapping");

    let body: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/imports/{job}/people"),
            &cookie,
        )
        .send()
        .await
        .expect("people")
        .json()
        .await
        .expect("json");
    let theirs = body
        .as_array()
        .expect("a list")
        .iter()
        .find(|person| person["source_id"].as_str() == Some(nameless_ref.as_str()))
        .expect("the person with no address");
    assert_eq!(theirs["email"], json!(""), "no address to offer");

    // And the rule the invitation route applies, which cannot be exercised through the route here:
    // an instance with no mail relay refuses the whole request before looking at anybody.
    assert!(run::unreachable(&format!(
        "someone{}",
        run::NO_ADDRESS_DOMAIN
    )));
    assert!(run::unreachable("   "));
    assert!(!run::unreachable("someone@example.org"));
}

#[tokio::test]
async fn the_import_surface_does_not_exist_for_anyone_but_an_instance_administrator() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let cookie = app.cookie_for(fx.bob).await;

    for (method, path) in [
        (reqwest::Method::GET, "/api/v1/imports".to_owned()),
        (reqwest::Method::POST, "/api/v1/imports/plan".to_owned()),
        (
            reqwest::Method::GET,
            format!("/api/v1/imports/{}", Uuid::new_v4()),
        ),
        (
            reqwest::Method::POST,
            format!("/api/v1/imports/{}/cancel", Uuid::new_v4()),
        ),
        (
            reqwest::Method::GET,
            format!("/api/v1/imports/{}/people", Uuid::new_v4()),
        ),
    ] {
        let response = app
            .req(method.clone(), &path, &cookie)
            .json(&json!({"file": "whatever"}))
            .send()
            .await
            .expect("request");
        // 404 and not 403: to everyone else this surface does not exist, and a refusal that told
        // them apart would confirm there is something here to attack.
        assert_eq!(response.status(), 404, "{method} {path}");
    }
}

#[tokio::test]
async fn an_administrator_cannot_have_the_api_read_a_file_outside_the_import_directory() {
    // An administrator is trusted with the instance, not handed a way to make the API open any file
    // on the machine and report what it found.
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let mut admin: users::ActiveModel = users::Entity::find_by_id(fx.alice)
        .one(&app.db)
        .await
        .expect("query")
        .expect("alice")
        .into();
    admin.is_instance_admin = Set(true);
    admin.update(&app.db).await.expect("promote");
    let cookie = app.cookie_for(fx.alice).await;

    for file in ["../../etc/passwd", "/etc/passwd", ".ssh/id_ed25519", "a/b"] {
        let response = app
            .req(reqwest::Method::POST, "/api/v1/imports/plan", &cookie)
            .json(&json!({"file": file}))
            .send()
            .await
            .expect("request");
        assert_eq!(response.status(), 400, "{file} should be refused as a path");
        let body: Value = response.json().await.expect("json");
        // Refused as a path, not because the directory happens to be unset: those are the same
        // status for different reasons, and only one of them is the guard doing its job.
        assert!(
            body["message"]
                .as_str()
                .unwrap_or_default()
                .contains("not a path"),
            "{file} was refused for the wrong reason: {body}"
        );
    }

    // And a plain name gets past the guard, so the test above is not passing because everything
    // is refused.
    let response = app
        .req(reqwest::Method::POST, "/api/v1/imports/plan", &cookie)
        .json(&json!({"file": "no-such-archive"}))
        .send()
        .await
        .expect("request");
    let body: Value = response.json().await.expect("json");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("no archive of that name"),
        "a plain name should reach the directory, got {body}"
    );
}

// --- Replacing the instance ----------------------------------------------------------------------
//
// The most destructive thing the product can do, so it is tested on a database of its own: every
// other test in this binary runs in parallel against the shared one, and a wipe would take their
// data with it. The guards themselves refuse before touching anything, so those are checked on the
// shared database; only the deletion gets its own.

use crate::importer::wipe;

/// A database created for one test, migrated, and dropped afterwards.
struct ScratchDb {
    db: DatabaseConnection,
    name: String,
    admin_url: String,
}

impl ScratchDb {
    async fn create() -> Option<Self> {
        let base = std::env::var("RUCHOIR_TEST_DATABASE_URL").ok()?;
        let name = format!("ruchoir_wipe_{}", Uuid::new_v4().simple());
        let (prefix, _) = base.rsplit_once('/')?;
        let admin_url = format!("{prefix}/postgres");

        let admin = sea_orm::Database::connect(&admin_url).await.ok()?;
        admin
            .execute_raw(Statement::from_string(
                DatabaseBackend::Postgres,
                format!("CREATE DATABASE \"{name}\""),
            ))
            .await
            .ok()?;
        drop(admin);

        let db = sea_orm::Database::connect(&format!("{prefix}/{name}"))
            .await
            .ok()?;
        Migrator::up(&db, None).await.ok()?;
        Some(Self {
            db,
            name,
            admin_url,
        })
    }

    async fn drop_it(self) {
        let Self {
            db,
            name,
            admin_url,
        } = self;
        drop(db);
        if let Ok(admin) = sea_orm::Database::connect(&admin_url).await {
            let _ = admin
                .execute_raw(Statement::from_string(
                    DatabaseBackend::Postgres,
                    format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"),
                ))
                .await;
        }
    }
}

/// A restart must not leave an import running for ever.
///
/// The run lives in a task inside the process. Restart the server and the task is gone, but the
/// row still said "running": the screen watched a bar that would never move again, and nothing
/// said why.
///
/// On its own database, like the wipe tests and for the same reason: the sweep closes every
/// running job it finds, and on the shared one that would be another test's import.
#[tokio::test]
async fn a_restart_closes_the_imports_that_were_running() {
    let Some(scratch) = ScratchDb::create().await else {
        return;
    };
    let admin = make_admin(&scratch.db).await;
    let job = run::start_job(&scratch.db, "mattermost", admin, None, "{}")
        .await
        .expect("job");
    assert!(run::one_is_running(&scratch.db).await.expect("query"));

    let closed = run::close_abandoned_jobs(&scratch.db).await.expect("close");
    assert_eq!(closed, 1);
    assert!(
        !run::one_is_running(&scratch.db).await.expect("query"),
        "and a new import is possible again"
    );

    let after = crate::entities::import_jobs::Entity::find_by_id(job)
        .one(&scratch.db)
        .await
        .expect("query")
        .expect("job");
    assert_eq!(after.status, "failed");
    assert!(
        after.error.unwrap_or_default().contains("restarted"),
        "the reason has to say what happened, in words the administrator can act on"
    );
    assert!(after.finished_at.is_some());
    scratch.drop_it().await;
}

/// Two at once would write over each other's progress and race on the same accounts.
#[tokio::test]
async fn one_import_at_a_time() {
    let Some(scratch) = ScratchDb::create().await else {
        return;
    };
    let admin = make_admin(&scratch.db).await;
    assert!(!run::one_is_running(&scratch.db).await.expect("query"));
    run::start_job(&scratch.db, "mattermost", admin, None, "{}")
        .await
        .expect("job");
    assert!(run::one_is_running(&scratch.db).await.expect("query"));

    // A finished one does not hold the door.
    run::finish_job(
        &scratch.db,
        run::start_job(&scratch.db, "mattermost", admin, None, "{}")
            .await
            .expect("second"),
        "completed",
    )
    .await
    .expect("finish");
    assert!(run::one_is_running(&scratch.db).await.expect("query"));
    run::close_abandoned_jobs(&scratch.db).await.expect("close");
    assert!(!run::one_is_running(&scratch.db).await.expect("query"));
    scratch.drop_it().await;
}

/// A correspondence remembered for a row that has since gone.
async fn remember(db: &DatabaseConnection, job: Uuid, kind: &str, external: &str, internal: Uuid) {
    crate::entities::import_mappings::ActiveModel {
        id: Set(Uuid::new_v4()),
        job_id: Set(job),
        space_id: Set(None),
        source: Set("synthetic".to_owned()),
        kind: Set(kind.to_owned()),
        external_ref: Set(external.to_owned()),
        internal_id: Set(internal),
        created_at: Set(OffsetDateTime::now_utc()),
    }
    .insert(db)
    .await
    .expect("mapping");
}

async fn mappings(db: &DatabaseConnection) -> Vec<crate::entities::import_mappings::Model> {
    crate::entities::import_mappings::Entity::find()
        .all(db)
        .await
        .expect("query")
}

/// An import run after the rows it once wrote have gone must not believe they are still here.
///
/// Found on the production instance: an archive imported, the instance replaced, the same source
/// imported again. The second run recognised the first one's spaces from their correspondences,
/// hung its first conversation off one of them, and failed on the foreign key - on every run.
#[tokio::test]
async fn an_import_forgets_the_correspondences_whose_row_is_gone() {
    let Some(scratch) = ScratchDb::create().await else {
        return;
    };
    let admin = make_admin(&scratch.db).await;
    let (kept, _) = crate::messaging::spaces::create_owned_space(&scratch.db, "Gardé", admin)
        .await
        .expect("space");
    let job = run::start_job(&scratch.db, "synthetic", admin, None, "{}")
        .await
        .expect("job");
    remember(&scratch.db, job, run::KIND_SPACE, "gardé", kept).await;
    remember(&scratch.db, job, run::KIND_SPACE, "parti", Uuid::new_v4()).await;
    remember(&scratch.db, job, run::KIND_USER, "admin", admin).await;
    remember(&scratch.db, job, run::KIND_USER, "parti", Uuid::new_v4()).await;
    remember(&scratch.db, job, run::KIND_CHANNEL, "parti", Uuid::new_v4()).await;
    remember(&scratch.db, job, run::KIND_MESSAGE, "parti", Uuid::new_v4()).await;
    remember(&scratch.db, job, run::KIND_FILE, "parti", Uuid::new_v4()).await;

    let forgotten = run::forget_vanished(&scratch.db).await.expect("forget");
    assert_eq!(forgotten, 5, "one of each kind pointed at nothing");

    let mut left: Vec<String> = mappings(&scratch.db)
        .await
        .into_iter()
        .map(|m| format!("{}:{}", m.kind, m.external_ref))
        .collect();
    left.sort();
    assert_eq!(
        left,
        vec![
            format!("{}:gardé", run::KIND_SPACE),
            format!("{}:admin", run::KIND_USER)
        ],
        "and what still exists is still recognised, or a re-run would import it twice"
    );
    assert_eq!(
        run::forget_vanished(&scratch.db).await.expect("again"),
        0,
        "nothing left to forget the second time"
    );
    scratch.drop_it().await;
}

/// Replacing the instance empties it for the import that follows, and that includes what earlier
/// imports remembered: kept, it tells that import that everything is already here.
#[tokio::test]
async fn a_replacement_forgets_what_earlier_imports_remembered() {
    let Some(scratch) = ScratchDb::create().await else {
        return;
    };
    let admin = make_admin(&scratch.db).await;
    let bystander = make_user(&scratch.db, "bystander").await;
    let (space, _) = crate::messaging::spaces::create_owned_space(&scratch.db, "Ancien", bystander)
        .await
        .expect("space");
    let job = run::start_job(&scratch.db, "synthetic", admin, None, "{}")
        .await
        .expect("job");
    run::finish_job(&scratch.db, job, "completed")
        .await
        .expect("finish");
    remember(&scratch.db, job, run::KIND_SPACE, "ancien", space).await;
    remember(&scratch.db, job, run::KIND_USER, "bystander", bystander).await;
    record_backup(&scratch.db, OffsetDateTime::now_utc()).await;

    wipe::replace_instance(
        &scratch.db,
        admin,
        "ruchoir.example.org",
        "https://ruchoir.example.org/",
    )
    .await
    .expect("replacement");

    assert!(
        mappings(&scratch.db).await.is_empty(),
        "no correspondence may outlive the rows it points at"
    );
    scratch.drop_it().await;
}

async fn record_backup(db: &DatabaseConnection, when: OffsetDateTime) {
    crate::entities::instance_events::ActiveModel {
        id: Set(Uuid::new_v4()),
        kind: Set("backup_taken".to_owned()),
        occurred_at: Set(when),
        actor_id: Set(None),
        detail: Set("{}".to_owned()),
    }
    .insert(db)
    .await
    .expect("backup event");
}

async fn make_admin(db: &DatabaseConnection) -> Uuid {
    let id = make_user(db, "wipe-admin").await;
    let mut model: users::ActiveModel = users::Entity::find_by_id(id)
        .one(db)
        .await
        .expect("query")
        .expect("user")
        .into();
    model.is_instance_admin = Set(true);
    model.update(db).await.expect("promote");
    id
}

#[tokio::test]
async fn a_replacement_keeps_the_account_that_ordered_it_and_its_rights() {
    // The invariant the whole file rests on. Without it the administrator loses their session
    // mid-run and can neither resume, cancel, nor read what happened.
    let Some(scratch) = ScratchDb::create().await else {
        return;
    };
    let admin = make_admin(&scratch.db).await;
    let bystander = make_user(&scratch.db, "bystander").await;
    let (space, _) = crate::messaging::spaces::create_owned_space(&scratch.db, "Ancien", bystander)
        .await
        .expect("space");
    record_backup(&scratch.db, OffsetDateTime::now_utc()).await;

    let destroyed = wipe::replace_instance(
        &scratch.db,
        admin,
        "ruchoir.example.org",
        "https://ruchoir.example.org/",
    )
    .await
    .expect("replacement");

    assert!(destroyed.spaces >= 1);
    assert!(destroyed.space_names.iter().any(|name| name == "Ancien"));

    let survivor = users::Entity::find_by_id(admin)
        .one(&scratch.db)
        .await
        .expect("query")
        .expect("the administrator survives");
    assert!(
        survivor.is_instance_admin,
        "and keeps the rights that let them do it"
    );
    assert!(
        users::Entity::find_by_id(bystander)
            .one(&scratch.db)
            .await
            .expect("query")
            .is_none(),
        "everyone else is gone"
    );
    assert!(
        spaces::Entity::find_by_id(space)
            .one(&scratch.db)
            .await
            .expect("query")
            .is_none(),
        "and so is every space"
    );

    scratch.drop_it().await;
}

#[tokio::test]
async fn a_replacement_leaves_a_record_of_itself_that_it_cannot_erase() {
    let Some(scratch) = ScratchDb::create().await else {
        return;
    };
    let admin = make_admin(&scratch.db).await;
    make_user(&scratch.db, "bystander").await;
    record_backup(&scratch.db, OffsetDateTime::now_utc()).await;

    wipe::replace_instance(
        &scratch.db,
        admin,
        "ruchoir.example.org",
        "https://ruchoir.example.org",
    )
    .await
    .expect("replacement");

    let record = crate::entities::instance_events::Entity::find()
        .filter(crate::entities::instance_events::Column::Kind.eq("instance_replaced"))
        .one(&scratch.db)
        .await
        .expect("query")
        .expect("the only account of it left");
    assert_eq!(record.actor_id, Some(admin));
    // What was destroyed, in the record, because everything that could have said so is gone.
    assert!(record.detail.contains("accounts"), "got {}", record.detail);

    scratch.drop_it().await;
}

#[tokio::test]
async fn a_replacement_without_the_address_typed_exactly_destroys_nothing() {
    // On a database of its own, like every test in this section, and for a reason learned the hard
    // way: a guard test that gets one case wrong does not fail, it wipes the database every other
    // test is using. Destructive code is never pointed at shared state, not even to watch it refuse.
    let Some(scratch) = ScratchDb::create().await else {
        return;
    };
    let admin = make_admin(&scratch.db).await;
    let bystander = make_user(&scratch.db, "bystander").await;
    record_backup(&scratch.db, OffsetDateTime::now_utc()).await;

    for typed in [
        "",
        "ruchoir",
        "RUCHOIR.EXAMPLE.ORG",
        "https://ruchoir.example.org",
        "ruchoir.example.org.evil.test",
    ] {
        let outcome =
            wipe::replace_instance(&scratch.db, admin, typed, "https://ruchoir.example.org").await;
        assert!(outcome.is_err(), "{typed:?} should not be accepted");
    }

    assert!(
        users::Entity::find_by_id(bystander)
            .one(&scratch.db)
            .await
            .expect("query")
            .is_some(),
        "a refused replacement touches nothing"
    );

    scratch.drop_it().await;
}

#[tokio::test]
async fn a_replacement_without_a_recent_backup_is_refused() {
    // The only guard that makes this reversible. Without it the operation is simply destruction,
    // and a guard that trusted a checkbox would be decoration.
    let Some(scratch) = ScratchDb::create().await else {
        return;
    };
    let admin = make_admin(&scratch.db).await;
    let bystander = make_user(&scratch.db, "bystander").await;

    let outcome = wipe::replace_instance(
        &scratch.db,
        admin,
        "ruchoir.example.org",
        "https://ruchoir.example.org",
    )
    .await;
    assert!(
        outcome.is_err(),
        "no backup has ever been recorded, so no replacement"
    );

    // One from last week, which is not a backup of what is here now.
    record_backup(
        &scratch.db,
        OffsetDateTime::now_utc() - time::Duration::days(7),
    )
    .await;
    let outcome = wipe::replace_instance(
        &scratch.db,
        admin,
        "ruchoir.example.org",
        "https://ruchoir.example.org",
    )
    .await;
    assert!(outcome.is_err(), "a week-old backup is not a recent one");

    assert!(
        users::Entity::find_by_id(bystander)
            .one(&scratch.db)
            .await
            .expect("query")
            .is_some(),
        "a refused replacement touches nothing"
    );

    scratch.drop_it().await;
}

#[tokio::test]
async fn what_a_replacement_would_destroy_is_counted_before_anything_happens() {
    let Some(scratch) = ScratchDb::create().await else {
        return;
    };
    make_admin(&scratch.db).await;
    let someone = make_user(&scratch.db, "someone").await;
    crate::messaging::spaces::create_owned_space(&scratch.db, "Comptabilité", someone)
        .await
        .expect("space");

    let dying = wipe::what_would_be_destroyed(&scratch.db)
        .await
        .expect("count");
    assert_eq!(dying.spaces, 1);
    assert_eq!(dying.accounts, 2);
    // Names, not only a number: one does not destroy a number.
    assert_eq!(dying.space_names, vec!["Comptabilité".to_string()]);

    scratch.drop_it().await;
}
