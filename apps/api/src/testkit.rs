//! A real server on throwaway datastores, for tests.
//!
//! Used by this crate's own end-to-end tests (`tests_integration`) and, through the `testkit`
//! feature, by the tests of an edition built elsewhere, so both boot exactly the same server. It
//! runs only when `RUCHOIR_TEST_DATABASE_URL` is set (and a Valkey is reachable at
//! `VALKEY_TEST_URL`); without them [`boot`] answers `None` and the test is skipped, except in CI,
//! where a missing database is a failure. Never point these at a database someone uses.

use std::net::SocketAddr;
use std::sync::Arc;

use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, DatabaseConnection};
use uuid::Uuid;

use ruchoir_migration::{Migrator, MigratorTrait};

use crate::auth::cookie::SESSION_COOKIE;
use crate::config::Config;
use crate::edition::Edition;
use crate::entities::{channel_members, channels, conversations, space_members, spaces, users};
use crate::state::AppState;

/// Applies the migrations exactly once across all tests in a binary, so parallel boots never race
/// two migration runners against the same database.
static SCHEMA_READY: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

/// A booted test server and the handles a test needs.
pub struct TestServer {
    /// `http://127.0.0.1:<port>`, the API's base address.
    pub base: String,
    /// Base URL of the internal WOPI listener, when live editing is on.
    pub wopi_base: Option<String>,
    pub db: DatabaseConnection,
    pub config: Config,
    pub valkey: fred::prelude::Pool,
    /// The state the server runs with, for what a background task drives rather than a request.
    pub state: AppState,
}

impl TestServer {
    /// The `Cookie` header value carrying a live session for `user_id`.
    pub async fn cookie_for(&self, user_id: Uuid) -> String {
        let sid = crate::auth::session::create(&self.valkey, &self.config, user_id)
            .await
            .expect("session");
        format!("{SESSION_COOKIE}={sid}")
    }
}

/// Boot the server as `edition`, with no object store (file byte endpoints report 503), or
/// `None` when the test infrastructure is not configured.
pub async fn boot(edition: Arc<dyn Edition>) -> Option<TestServer> {
    boot_with(edition, None, |_| {}).await
}

/// [`boot`] with a chosen object store and configuration adjustments: the tests that write bytes
/// pass an in-memory store, the office tests turn live editing on.
pub async fn boot_with(
    edition: Arc<dyn Edition>,
    storage: Option<Arc<crate::storage::S3Store>>,
    configure: impl FnOnce(&mut Config),
) -> Option<TestServer> {
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
        eprintln!("skipping integration tests: RUCHOIR_TEST_DATABASE_URL not set");
        return None;
    };
    let valkey_url =
        std::env::var("VALKEY_TEST_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());

    // Start from the process defaults, then point the datastores at the test instances.
    let mut config = Config::from_env().expect("config");
    config.database_url = database_url.clone();
    config.valkey_url = valkey_url;
    config.auto_migrate = false;
    // Never the publisher's relay from a test: the phone tests start one of their own.
    config.push_relay_url = None;
    // Short presence TTL so an offline transition is observable quickly in tests.
    config.presence_ttl_secs = 5;
    // An import directory, so the tests of the server-side path exercise the real guard instead of
    // the "no directory configured" refusal, which answers the same 400 for a different reason.
    let import_dir = std::env::temp_dir().join("ruchoir-test-imports");
    std::fs::create_dir_all(&import_dir).expect("import dir");
    config.import_dir = Some(import_dir);
    // A stand-in for the web bundle's shell, so the pages served with link preview tags have a head.
    let web_dist = std::env::temp_dir().join("ruchoir-test-web");
    std::fs::create_dir_all(&web_dist).expect("web dir");
    std::fs::write(
        web_dist.join("index.html"),
        "<html><head><title>Ruchoir</title></head><body></body></html>",
    )
    .expect("index");
    config.web_dist = web_dist;
    // The cards' and mails' language is asserted by the tests, whatever the machine has set.
    config.default_locale = crate::auth::mail_text::Locale::Fr;
    configure(&mut config);

    let db = crate::db::connect(&config).await.expect("connect db");
    if config.database_url == database_url {
        SCHEMA_READY
            .get_or_init(|| async {
                Migrator::up(&db, None).await.expect("migrate");
            })
            .await;
    }
    // A test that points the server at a database of its own has migrated it itself.
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
        // `None` unless the test asked for a store: the byte endpoints then report 503.
        storage,
        office: crate::office::Office::from_config(&config).map(Arc::new),
        edition,
        config: Arc::new(config.clone()),
    };

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let app = crate::http::router(state.clone());
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("serve");
    });
    let wopi_base = if state.office.is_some() {
        let wopi_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind wopi");
        let wopi_addr = wopi_listener.local_addr().expect("wopi addr");
        let wopi_app = crate::office::wopi_router(state.clone());
        tokio::spawn(async move {
            axum::serve(wopi_listener, wopi_app)
                .await
                .expect("serve wopi");
        });
        Some(format!("http://{wopi_addr}"))
    } else {
        None
    };

    Some(TestServer {
        base: format!("http://{addr}"),
        wopi_base,
        db,
        config,
        valkey,
        state,
    })
}

/// An active account named `name`, with an address nobody owns.
pub async fn make_user(db: &DatabaseConnection, name: &str) -> Uuid {
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

/// A space named `name`, owned by `owner`, with a public `#general` as its arrival channel (as
/// every real space has: arrivals and departures are written there).
pub async fn make_space(db: &DatabaseConnection, owner: Uuid, name: &str) -> Uuid {
    let space_id = Uuid::new_v4();
    spaces::ActiveModel {
        id: Set(space_id),
        name: Set(name.to_owned()),
        slug: Set(format!("test-{}", space_id.simple())),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("space");
    add_member(db, space_id, owner, "owner").await;
    let general = Uuid::new_v4();
    conversations::ActiveModel {
        id: Set(general),
        space_id: Set(space_id),
        kind: Set("channel".to_owned()),
        created_at: Set(time::OffsetDateTime::now_utc()),
    }
    .insert(db)
    .await
    .expect("conversation");
    channels::ActiveModel {
        id: Set(general),
        space_id: Set(space_id),
        name: Set("general".to_owned()),
        channel_type: Set("public".to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("channel");
    spaces::ActiveModel {
        id: Set(space_id),
        default_channel_id: Set(Some(general)),
        ..Default::default()
    }
    .update(db)
    .await
    .expect("default channel");
    channel_members::ActiveModel {
        channel_id: Set(general),
        user_id: Set(owner),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("channel member");
    space_id
}

/// Put `user_id` in `space_id` with today's `role` (`owner`, `admin`, `member` or `guest`); the
/// permission model follows from it (the database derives standing and roles).
pub async fn add_member(db: &DatabaseConnection, space_id: Uuid, user_id: Uuid, role: &str) {
    space_members::ActiveModel {
        space_id: Set(space_id),
        user_id: Set(user_id),
        role: Set(role.to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("space member");
}
