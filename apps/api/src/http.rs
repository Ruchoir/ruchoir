//! HTTP surface: router, health endpoints, static web hosting and security headers.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use fred::interfaces::ClientLike;
use serde::Serialize;
use tower::{ServiceBuilder, ServiceExt};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;
use utoipa::ToSchema;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::key_extractor::SmartIpKeyExtractor;
use tower_governor::GovernorLayer;

use crate::state::AppState;

/// Liveness payload returned by `/healthz`. This never touches dependencies, so it stays a pure
/// "the process is up" signal for orchestration and load balancers.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct Health {
    /// Always `"ok"` when the endpoint responds.
    status: &'static str,
    /// Service identifier.
    service: &'static str,
    /// Semantic version of the running binary.
    version: &'static str,
}

impl Health {
    fn ok() -> Self {
        Self {
            status: "ok",
            service: "ruchoir-api",
            version: env!("CARGO_PKG_VERSION"),
        }
    }
}

/// Readiness payload returned by `/api/v1/health`, including dependency probes.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ApiHealth {
    /// `"ok"` when every dependency is reachable, otherwise `"degraded"`.
    status: &'static str,
    /// Service identifier.
    service: &'static str,
    /// Semantic version of the running binary.
    version: &'static str,
    /// PostgreSQL reachability: `"ok"` or `"down"`.
    database: &'static str,
    /// Valkey reachability: `"ok"` or `"down"`.
    cache: &'static str,
}

/// Liveness probe. Used by container orchestration and load balancers.
#[utoipa::path(
    get,
    path = "/healthz",
    tag = "health",
    responses((status = 200, description = "Service is alive", body = Health))
)]
pub(crate) async fn healthz() -> Json<Health> {
    Json(Health::ok())
}

/// Readiness endpoint: reports whether PostgreSQL and Valkey are reachable. Kept separate from
/// `/healthz` so liveness never depends on downstream systems.
#[utoipa::path(
    get,
    path = "/api/v1/health",
    tag = "health",
    responses((status = 200, description = "API readiness with dependency probes", body = ApiHealth))
)]
pub(crate) async fn api_health(State(state): State<AppState>) -> Json<ApiHealth> {
    let database = match state.db.ping().await {
        Ok(()) => "ok",
        Err(_) => "down",
    };
    // A bare PING; the reply payload is irrelevant, only whether the round-trip succeeds.
    let cache = match state.valkey.ping::<String>(None).await {
        Ok(_) => "ok",
        Err(_) => "down",
    };
    let status = if database == "ok" && cache == "ok" {
        "ok"
    } else {
        "degraded"
    };

    Json(ApiHealth {
        status,
        service: "ruchoir-api",
        version: env!("CARGO_PKG_VERSION"),
        database,
        cache,
    })
}

/// Build the full application router.
///
/// Order of concerns:
/// 1. JSON API routes under `/api`, including the generated OpenAPI document.
/// 2. A liveness route at `/healthz`.
/// 3. A static-file fallback that serves the exported web bundle, with SPA-style
///    fallback to `index.html` for client-side routes.
///
/// A conservative baseline of security headers is applied to every response,
/// aligned with the "self-hosted, no external origin" posture. It is tightened later
/// (nonce-based CSP, HSTS once TLS is terminated in front of the API).
pub fn router(state: AppState) -> Router {
    let web_dist = state.config.web_dist.clone();
    let index = web_dist.join("index.html");
    let static_service = ServeDir::new(&web_dist)
        .fallback(any(move |req: Request| spa_fallback(index.clone(), req)));

    // Content Security Policy: same-origin only.
    //
    // `script-src`/`style-src` allow `'unsafe-inline'` as a documented, TEMPORARY
    // deviation: the Next.js static export emits inline bootstrap/hydration scripts and
    // styles, and a static export cannot use per-request nonces. Without this the client
    // never hydrates. Planned hardening: have the API inject a per-request nonce
    // into index.html and this header, then drop `'unsafe-inline'`.
    //
    // `img-src` also allows `blob:`, which the avatar and space-icon crop step needs: it reads the
    // picked file into an object URL to preview it before upload. A `blob:` URL is same-origin and
    // created by the page from data it already holds, so it opens no remote origin and leaves the
    // no-external-request rule intact. `data:` was already allowed for the same class of reason
    // (the locally generated default avatars).
    let csp = "default-src 'self'; base-uri 'self'; object-src 'none'; \
               frame-ancestors 'none'; img-src 'self' data: blob:; font-src 'self'; \
               style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; \
               connect-src 'self'";

    // Coarse per-IP rate limit on the auth surface: a backstop above the per-account lockout.
    // `SmartIpKeyExtractor` reads a forwarded client IP behind a proxy and falls back to the
    // connection peer (see the connect-info make-service in `main`).
    let governor = Arc::new(
        GovernorConfigBuilder::default()
            .key_extractor(SmartIpKeyExtractor)
            .period(Duration::from_millis(state.config.auth_rate_period_ms))
            .burst_size(state.config.auth_rate_burst)
            .finish()
            .expect("valid rate-limit configuration"),
    );
    let auth_routes = crate::auth::routes::router().layer(GovernorLayer::new(governor));

    let mut router = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/v1/health", get(api_health))
        .route("/api/openapi.json", get(crate::openapi::openapi_json))
        .nest("/api/v1/auth", auth_routes)
        // The messaging REST surface and the real-time transport use absolute `/api/v1/...` paths
        // and merge in here. Both are guarded per request by the `AuthSession` extractor, so no
        // blanket auth layer is needed. Merging (not a second `/api/v1` nest) avoids path overlap
        // with the health route and the auth nest above.
        .merge(crate::messaging::routes::router())
        .merge(crate::realtime::routes::router())
        // The files surface (tree, upload/versions, download/preview/thumbnail, shares). Its upload
        // routes carry a raised request-body limit sized from the configured cap plus a small
        // multipart overhead; the byte responses are proxied through the API so the object store is
        // never exposed to the browser.
        .merge(crate::files::router(
            state.config.upload_max_bytes.saturating_add(1 << 20) as usize,
        ));

    // Optional self-hosted emoji pack. `ServeDir` handles path traversal safely and returns 404
    // for missing files, which the client treats as "no asset" and renders the native glyph. The
    // pack lives outside the web bundle so a deployment can omit it.
    //
    // Emoji assets are large and change only when the pack is rebuilt, so they are cached for a week.
    // The client fetches the manifest and the single sprite once, then reuses them; this caps the
    // pack at a couple of requests per client per week instead of one per glyph on every load. The
    // window is intentionally not `immutable`: `sprite.svg`/`manifest.json` keep a stable name across
    // rebuilds, so a bounded max-age lets a rebuilt pack propagate (or a hard refresh forces it).
    if let Some(dir) = state.config.emoji_dir.clone() {
        let emoji_service = ServeDir::new(dir);
        router = router.nest_service(
            "/emoji",
            ServiceBuilder::new()
                .layer(SetResponseHeaderLayer::overriding(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=604800"),
                ))
                .service(emoji_service),
        );
    }

    router
        .fallback_service(static_service)
        .layer(set_header(header::CONTENT_SECURITY_POLICY, csp))
        .layer(set_header(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .layer(set_header(header::REFERRER_POLICY, "no-referrer"))
        .layer(set_header(
            HeaderName::from_static("permissions-policy"),
            "geolocation=(), camera=(), microphone=()",
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Serve the single-page application for a path that is not a file in the bundle.
///
/// The client is a state machine rather than a set of routes, but a few real paths still reach it:
/// the API emails absolute links back into the app (address confirmation, password reset), and those
/// must land on the app shell with a normal `200`, not on an error status. Anything that is not a
/// browser navigation (a missing asset, an XHR) keeps a truthful `404` instead of silently receiving
/// HTML, which is what turns a typo in an asset path into a confusing parse error.
async fn spa_fallback(index: PathBuf, req: Request) -> Response {
    let accepts_html = req
        .headers()
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| accept.contains("text/html"));
    if !accepts_html {
        return StatusCode::NOT_FOUND.into_response();
    }
    match ServeFile::new(index).oneshot(req).await {
        Ok(response) => response.map(Body::new),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Build a layer that sets a static header value on every response.
fn set_header(name: HeaderName, value: &'static str) -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::overriding(name, HeaderValue::from_static(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    /// Write an index file into a unique temporary directory and return its path.
    fn temp_index(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ruchoir-http-{name}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let index = dir.join("index.html");
        std::fs::write(&index, "<!doctype html><title>Ruchoir</title>").expect("write index");
        index
    }

    #[tokio::test]
    async fn navigation_to_a_client_route_serves_the_shell_with_200() {
        // The address-confirmation and password-reset links the API emails point at paths that are
        // not files in the bundle: they must resolve to the app shell, not to an error status.
        let index = temp_index("navigation");
        let request = Request::builder()
            .uri("/verify-email?token=abc")
            .header(header::ACCEPT, "text/html,application/xhtml+xml")
            .body(Body::empty())
            .expect("request");

        let response = spa_fallback(index, request).await;

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 4096).await.expect("body");
        assert!(String::from_utf8_lossy(&body).contains("Ruchoir"));
    }

    #[tokio::test]
    async fn a_missing_asset_still_gets_a_404() {
        // Only a navigation resolves to the shell; anything else keeps a truthful 404 so a wrong
        // asset path fails loudly instead of parsing HTML as a script or an image.
        let index = temp_index("asset");
        let request = Request::builder()
            .uri("/img/missing.png")
            .header(header::ACCEPT, "image/png")
            .body(Body::empty())
            .expect("request");

        let response = spa_fallback(index, request).await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
