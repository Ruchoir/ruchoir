//! The app's own protocol, `ruchoir-app`: one origin for the interface, every instance's API
//! (`/i/<instance-id>/api/v1/...`) and the emoji (`/emoji/...`). The rules are in
//! `ruchoir_desktop_core::proxy`; this is where they meet the webview.
//!
//! The interface is the embedded web export. A path the export does not have and that names no file
//! (no dot in its last segment) answers `index.html`, so the interface's deep paths
//! (`/e/<space>/c/<channel>`) survive a reload, as the API's `spa_fallback` does on the web. In a
//! debug build, `RUCHOIR_DESKTOP_DEV_URL` (for instance `http://localhost:3112`, the desktop
//! `next dev`) serves the interface instead, with hot reload.

use std::sync::Mutex;

use ruchoir_desktop_core::proxy::{self, Answer, EmojiCache, Outcome, Route};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeResponder};

use crate::state::{changed, Desktop};

/// The emoji pack's files once fetched (the sprite alone is 5 MB): 24 MB at most.
pub struct EmojiStore(pub Mutex<EmojiCache>);

impl Default for EmojiStore {
    fn default() -> Self {
        Self(Mutex::new(EmojiCache::new(24 * 1024 * 1024)))
    }
}

/// Add the protocol to the app being built.
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(
        crate::APP_SCHEME,
        |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                respond(&app, request, responder).await;
            });
        },
    )
}

async fn respond<R: Runtime>(
    app: &AppHandle<R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let path = request.uri().path().to_string();
    let query = request
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let answer = match proxy::route(&path) {
        Route::Api { instance, rest } => {
            api(app, &instance, &format!("{rest}{query}"), &rest, request).await
        }
        Route::OpenApi(rest) => match app.state::<Desktop>().view().id {
            Some(open) => api(app, &open, &format!("{rest}{query}"), &rest, request).await,
            None => empty(404),
        },
        Route::Emoji(emoji) => emoji_answer(app, &format!("{emoji}{query}"), request).await,
        Route::Asset(asset) => asset_answer(app, &asset).await,
    };
    let mut builder = Response::builder().status(answer.status);
    for (name, value) in &answer.headers {
        builder = builder.header(name, value);
    }
    let response = builder.body(answer.body).unwrap_or_else(|_| {
        Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Vec::new())
            .expect("an empty response")
    });
    responder.respond(response);
}

fn empty(status: u16) -> Answer {
    Answer {
        status,
        headers: Default::default(),
        body: Vec::new(),
    }
}

async fn api<R: Runtime>(
    app: &AppHandle<R>,
    instance: &str,
    path_and_query: &str,
    rest: &str,
    request: Request<Vec<u8>>,
) -> Answer {
    let desktop = app.state::<Desktop>();
    let Some((origin, token)) = desktop.credentials(instance) else {
        return empty(404);
    };
    let Some(token) = token else {
        return empty(401);
    };
    let method = request.method().clone();
    let (parts, body) = request.into_parts();
    let answer = proxy::forward(
        &desktop.http,
        method.clone(),
        path_and_query,
        &parts.headers,
        body,
        &origin,
        Some(&token),
    )
    .await;
    match proxy::outcome_with_body(rest, &method, answer.status, &answer.body) {
        Outcome::Normal => {}
        Outcome::SignedOut | Outcome::LoggedOut => {
            desktop.forget_session(instance);
            changed(app);
        }
    }
    answer
}

async fn emoji_answer<R: Runtime>(
    app: &AppHandle<R>,
    path_and_query: &str,
    request: Request<Vec<u8>>,
) -> Answer {
    let store = app.state::<EmojiStore>();
    if let Some(kept) = store.0.lock().ok().and_then(|c| c.get(path_and_query)) {
        return kept;
    }
    let desktop = app.state::<Desktop>();
    let Some(origin) = desktop.active_origin() else {
        return empty(404);
    };
    let answer = proxy::forward(
        &desktop.http,
        request.method().clone(),
        path_and_query,
        request.headers(),
        Vec::new(),
        &origin,
        None,
    )
    .await;
    if let Ok(mut cache) = store.0.lock() {
        cache.put(path_and_query, &answer);
    }
    answer
}

async fn asset_answer<R: Runtime>(app: &AppHandle<R>, path: &str) -> Answer {
    #[cfg(debug_assertions)]
    if let Ok(dev) = std::env::var("RUCHOIR_DESKTOP_DEV_URL") {
        let desktop = app.state::<Desktop>();
        return proxy::forward(
            &desktop.http,
            tauri::http::Method::GET,
            path,
            &Default::default(),
            Vec::new(),
            dev.trim_end_matches('/'),
            None,
        )
        .await;
    }
    let resolver = app.asset_resolver();
    let asset = resolver.get(path.to_string()).or_else(|| {
        let last = path.rsplit('/').next().unwrap_or_default();
        (!last.contains('.'))
            .then(|| resolver.get("index.html".to_string()))
            .flatten()
    });
    let Some(asset) = asset else {
        return empty(404);
    };
    let mut headers = tauri::http::HeaderMap::new();
    if let Ok(value) = asset.mime_type.parse() {
        headers.insert(header::CONTENT_TYPE, value);
    }
    if let Some(csp) = asset.csp_header.and_then(|csp| csp.parse().ok()) {
        headers.insert(header::CONTENT_SECURITY_POLICY, csp);
    }
    Answer {
        status: 200,
        headers,
        body: asset.bytes,
    }
}
