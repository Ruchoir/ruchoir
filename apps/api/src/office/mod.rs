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
pub(crate) mod sessions;
pub(crate) mod templates;
pub mod tokens;
pub mod wopi;

pub use wopi::wopi_router;

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
}

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
            client: Client::builder(TokioExecutor::new()).build_http(),
            discovery: RwLock::new(None),
        })
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
    pub async fn refresh_discovery(&self) -> Result<(), OfficeError> {
        let request = Request::get(format!("{}/hosting/discovery", self.engine_url))
            .header("x-forwarded-host", &self.public_authority)
            .header("x-forwarded-proto", self.public_scheme())
            .body(Body::empty())
            .map_err(|_| OfficeError::Internal)?;
        let response = self
            .client
            .request(request)
            .await
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
        self.set_discovery(Discovery::parse(xml)?);
        Ok(())
    }
}

/// Keep the discovery fresh: at start, then every hour, and every minute while the engine has not
/// answered yet (an engine that starts after the API is caught up quickly).
pub fn spawn_discovery_refresh(office: Arc<Office>) {
    tokio::spawn(async move {
        loop {
            let wait = match office.refresh_discovery().await {
                Ok(()) => Duration::from_secs(3600),
                Err(error) => {
                    tracing::warn!(%error, "office engine discovery not available yet");
                    Duration::from_secs(60)
                }
            };
            tokio::time::sleep(wait).await;
        }
    });
}
