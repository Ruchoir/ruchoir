//! The app's own protocol, `ruchoir-app`: one origin for the interface and, from the proxy step on,
//! every instance's API (`/i/<instance-id>/api/v1/...`) and the emoji (`/emoji/...`).
//!
//! For now it serves the embedded web export. A path the export does not have and that names no file
//! (no dot in its last segment) answers `index.html`, so the interface's own deep paths
//! (`/e/<space>/c/<channel>`) survive a reload, as the API's `spa_fallback` does on the web.

use tauri::http::{header, Response, StatusCode};
use tauri::Runtime;

/// Add the protocol to the app being built.
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(
        crate::APP_SCHEME,
        |ctx, request, responder| {
            let path = request.uri().path().to_string();
            let resolver = ctx.app_handle().asset_resolver();
            let asset = resolver.get(path.clone()).or_else(|| {
                let last = path.rsplit('/').next().unwrap_or_default();
                (!last.contains('.'))
                    .then(|| resolver.get("index.html".to_string()))
                    .flatten()
            });
            let response = match asset {
                Some(asset) => {
                    let mut builder = Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, asset.mime_type);
                    if let Some(csp) = asset.csp_header {
                        builder = builder.header("Content-Security-Policy", csp);
                    }
                    builder.body(asset.bytes)
                }
                None => Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Vec::new()),
            };
            responder.respond(response.expect("a well-formed response"));
        },
    )
}
