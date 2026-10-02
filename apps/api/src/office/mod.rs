//! Live office editing: Ruchoir as a WOPI host for an office engine (Euro-Office by default).
//!
//! The engine runs as its own service and never faces the internet. Three surfaces connect it:
//!
//! - [`sessions`]: public, authenticated endpoints a member's browser calls to open a file, create
//!   a blank document, and say they are still editing.
//! - [`wopi`]: an internal listener the engine calls to read a file, lock it and save it. Never
//!   published; every call carries an access token bound to one member and one file ([`tokens`]).
//! - [`proxy`]: the relay of the editor's own hostname (`RUCHOIR_OFFICE_PUBLIC_URL`) to the engine,
//!   so the editor runs in an origin of its own and cannot act inside Ruchoir.
//!
//! What the engine can open is read from its discovery document ([`discovery`]). See
//! `docs/office-editing.md` and ADR 0003.

pub mod discovery;
pub mod error;
pub mod locks;
pub mod presence;
pub mod proxy;
pub(crate) mod sessions;
pub(crate) mod templates;
pub mod tokens;
pub mod wopi;

pub use wopi::wopi_router;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

use axum::routing::post;
use axum::Router;

use crate::config::{host_of, Config};
use crate::state::AppState;
use discovery::Discovery;
use error::OfficeError;

/// The public office routes, guarded per request by the session extractor.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/files/office", post(sessions::create_blank))
        .route(
            "/api/v1/files/{file_id}/office",
            post(sessions::open_session),
        )
        .route(
            "/api/v1/files/{file_id}/office/converted",
            axum::routing::get(sessions::converted_copy),
        )
        .route(
            "/api/v1/files/{file_id}/office/heartbeat",
            post(sessions::heartbeat).delete(sessions::end_heartbeat),
        )
}

/// The engine, as the API knows it.
pub struct Office {
    engine_url: String,
    public_origin: String,
    public_authority: String,
    public_host: String,
    client: Client<HttpConnector, Body>,
    discovery: RwLock<Option<Arc<Discovery>>>,
    /// How long the engine has to start answering a request, in milliseconds.
    response_timeout_ms: AtomicU64,
}

/// How long the engine has to accept a connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the engine has to start answering (its headers, not the whole body: an editor's assets
/// and a co-editing socket legitimately stream for much longer). A conversion of a large file is
/// the slowest answer seen; a minute is well above it.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(60);

impl Office {
    /// Build the handle when live editing is configured.
    pub fn from_config(config: &Config) -> Option<Self> {
        let engine_url = config.office_url.clone()?;
        let public = config.office_public_url.clone()?;
        let public_host = host_of(&public)?;
        let (scheme, rest) = public.split_once("://")?;
        let public_authority = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
        Some(Self {
            engine_url,
            public_origin: format!("{scheme}://{public_authority}"),
            public_authority,
            public_host,
            client: Client::builder(TokioExecutor::new()).build({
                let mut connector = HttpConnector::new();
                connector.set_connect_timeout(Some(CONNECT_TIMEOUT));
                connector
            }),
            discovery: RwLock::new(None),
            response_timeout_ms: AtomicU64::new(RESPONSE_TIMEOUT.as_millis() as u64),
        })
    }

    /// How long the engine has to start answering a request.
    pub fn response_timeout(&self) -> Duration {
        Duration::from_millis(self.response_timeout_ms.load(Ordering::Relaxed))
    }

    /// Shorten the wait, for the tests of a silent engine.
    #[cfg(test)]
    pub fn set_response_timeout(&self, timeout: Duration) {
        self.response_timeout_ms
            .store(timeout.as_millis() as u64, Ordering::Relaxed);
    }

    pub fn engine_url(&self) -> &str {
        &self.engine_url
    }

    /// `https://office.example.org`, no path.
    pub fn public_origin(&self) -> &str {
        &self.public_origin
    }

    /// `office.example.org[:port]`, as the engine must believe it is called.
    pub fn public_authority(&self) -> &str {
        &self.public_authority
    }

    /// `office.example.org`, for matching an incoming request.
    pub fn public_host(&self) -> &str {
        &self.public_host
    }

    /// `https` or `http`.
    pub fn public_scheme(&self) -> &str {
        self.public_origin.split("://").next().unwrap_or("https")
    }

    pub fn client(&self) -> &Client<HttpConnector, Body> {
        &self.client
    }

    pub fn discovery(&self) -> Option<Arc<Discovery>> {
        self.discovery.read().ok()?.clone()
    }

    pub fn set_discovery(&self, discovery: Discovery) {
        if let Ok(mut slot) = self.discovery.write() {
            *slot = Some(Arc::new(discovery));
        }
    }

    /// Read the engine's discovery, as served under the public hostname.
    ///
    /// When the engine does not answer, what it opens is forgotten: the editor is then reported
    /// unavailable (capabilities, sessions), and the client shows files the way it did without it.
    pub async fn refresh_discovery(&self) -> Result<(), OfficeError> {
        let fetched = self.fetch_discovery().await;
        match fetched {
            Ok(discovery) => {
                self.set_discovery(discovery);
                Ok(())
            }
            Err(error) => {
                if let Ok(mut slot) = self.discovery.write() {
                    *slot = None;
                }
                Err(error)
            }
        }
    }

    async fn fetch_discovery(&self) -> Result<Discovery, OfficeError> {
        let request = Request::get(format!("{}/hosting/discovery", self.engine_url))
            .header("x-forwarded-host", &self.public_authority)
            .header("x-forwarded-proto", self.public_scheme())
            .body(Body::empty())
            .map_err(|_| OfficeError::Internal)?;
        let response = tokio::time::timeout(self.response_timeout(), self.client.request(request))
            .await
            .map_err(|_| OfficeError::EngineUnavailable)?
            .map_err(|_| OfficeError::EngineUnavailable)?;
        if !response.status().is_success() {
            return Err(OfficeError::EngineUnavailable);
        }
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|_| OfficeError::EngineUnavailable)?
            .to_bytes();
        let xml = std::str::from_utf8(&bytes).map_err(|_| OfficeError::Discovery("not UTF-8"))?;
        Discovery::parse(xml)
    }
}

/// Keep the discovery fresh, and know within a minute when the engine stops or comes back: an
/// engine that starts after the API, or restarts, is picked up on its own. Logged on a change only.
pub fn spawn_discovery_refresh(office: Arc<Office>) {
    tokio::spawn(async move {
        let mut was_up: Option<bool> = None;
        loop {
            let result = office.refresh_discovery().await;
            let up = result.is_ok();
            if was_up != Some(up) {
                match result {
                    Ok(()) => tracing::info!("office engine available"),
                    Err(error) => tracing::warn!(%error, "office engine not available"),
                }
                was_up = Some(up);
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}
