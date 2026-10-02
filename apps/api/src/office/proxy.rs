//! The relay of the editor's own hostname to the engine.
//!
//! The browser loads the editor from `RUCHOIR_OFFICE_PUBLIC_URL`, a hostname of its own that points
//! at this same API. The outermost layer of the router ([`dispatch`]) hands every request for that
//! host to [`relay`], so the office hostname never reaches Ruchoir's routes, and Ruchoir's host never
//! reaches the engine. The editor therefore runs in an origin separate from Ruchoir's: whatever runs
//! in the engine's pages cannot read or drive Ruchoir, and Ruchoir's `__Host-` session cookie is
//! never even sent to it.
//!
//! Only the paths the editor needs are relayed (observed on Euro-Office 9.3.4); the engine's admin,
//! example, converter and command endpoints answer `404` from here.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::{Message as AxMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::header::{CONTENT_SECURITY_POLICY, SET_COOKIE, UPGRADE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as TMessage;

use crate::state::AppState;

use super::Office;

/// Headers that belong to one hop, or that would carry credentials or a forged origin.
const DROPPED: [&str; 12] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "cookie",
    "authorization",
    "forwarded",
];

/// Outermost router layer: requests for the office hostname go to the relay, the rest to Ruchoir.
pub async fn dispatch(State(state): State<AppState>, req: Request, next: Next) -> Response {
    match state.office.as_ref() {
        Some(office) if serves(office, &req) => {
            relay(
                office.clone(),
                &state.config.public_origin(),
                &state.config.wopi_base_url,
                req,
            )
            .await
        }
        _ => next.run(req).await,
    }
}

/// Whether `req` is addressed to the office hostname.
pub fn serves(office: &Office, req: &Request) -> bool {
    let host = req
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .or_else(|| req.uri().host())
        .unwrap_or("");
    let host = host.rsplit_once(':').map_or(host, |(h, port)| {
        if port.bytes().all(|b| b.is_ascii_digit()) {
            h
        } else {
            host
        }
    });
    host.eq_ignore_ascii_case(office.public_host())
}

async fn relay(
    office: Arc<Office>,
    ruchoir_origin: &str,
    wopi_base: &str,
    req: Request,
) -> Response {
    if !allowed(req.uri().path())
        || !wopi_src_is_ours(req.uri().path(), req.uri().query(), wopi_base)
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let websocket = req
        .headers()
        .get(UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    if websocket {
        relay_websocket(office, req).await
    } else {
        relay_http(office, ruchoir_origin, req).await
    }
}

/// Whether a path is one the editor needs.
pub fn allowed(path: &str) -> bool {
    // The engine's own nginx decodes and normalises the path after this check, so anything that
    // could turn into a separator or a dot segment once decoded is refused here, encoded or not.
    let lower = path.to_ascii_lowercase();
    if path.contains("/.")
        || path.contains("//")
        || path.contains('\\')
        || ["%2e", "%2f", "%5c"]
            .iter()
            .any(|encoded| lower.contains(encoded))
    {
        return false;
    }
    const ROOTS: [&str; 5] = [
        "/hosting/wopi/",
        "/web-apps/apps/",
        "/cache/files/",
        "/downloadfile/",
        "/printfile/",
    ];
    if ROOTS.iter().any(|root| path.starts_with(root)) {
        return true;
    }
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let (Some(version), Some(rest)) = (parts.next(), parts.next()) else {
        return false;
    };
    if !is_engine_version(version) {
        return false;
    }
    const VERSIONED: [&str; 9] = [
        "sdkjs/",
        "sdkjs-plugins/",
        "fonts/",
        "web-apps/",
        "doc/",
        "dictionaries/",
        "themes.json",
        "plugins.json",
        "document_editor_service_worker.js",
    ];
    VERSIONED.iter().any(|prefix| rest.starts_with(prefix))
}

/// `9.3.4-2344a07b…`: the engine's versioned static prefix.
fn is_engine_version(segment: &str) -> bool {
    let Some((numbers, hash)) = segment.split_once('-') else {
        return false;
    };
    let dotted: Vec<&str> = numbers.split('.').collect();
    dotted.len() == 3
        && dotted
            .iter()
            .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        && !hash.is_empty()
        && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Whether an editor page request names one of this instance's own files. The engine fetches
/// whatever `WOPISrc` says, server side, so anything else would turn it into a way to reach other
/// hosts. Paths outside `/hosting/wopi/` carry no `WOPISrc` and are not concerned.
pub fn wopi_src_is_ours(path: &str, query: Option<&str>, wopi_base: &str) -> bool {
    if !path.starts_with("/hosting/wopi/") {
        return true;
    }
    let mut sources = query
        .unwrap_or("")
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .filter(|(name, _)| name.eq_ignore_ascii_case("wopisrc"))
        .map(|(_, value)| percent_decode(value));
    let (Some(Some(source)), None) = (sources.next(), sources.next()) else {
        return false;
    };
    source
        .strip_prefix(wopi_base)
        .and_then(|rest| rest.strip_prefix("/wopi/files/"))
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok() && id.len() == 36)
}

/// Decode `%XX` escapes (and `+` as a space); `None` when an escape is malformed or the result is
/// not UTF-8.
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Whether a request header may be passed on to the engine.
pub fn forwardable(name: &HeaderName) -> bool {
    let name = name.as_str();
    !(DROPPED.contains(&name) || name.starts_with("x-forwarded-"))
}

/// Let Ruchoir, and only Ruchoir, frame the engine's pages.
pub fn frame_for(headers: &mut HeaderMap, ruchoir_origin: &str) {
    let ours = format!("frame-ancestors {ruchoir_origin}");
    let policy = match headers
        .get(CONTENT_SECURITY_POLICY)
        .and_then(|v| v.to_str().ok())
    {
        Some(existing) => {
            let mut kept: Vec<&str> = existing
                .split(';')
                .map(str::trim)
                .filter(|d| !d.is_empty() && !d.starts_with("frame-ancestors"))
                .collect();
            kept.push(&ours);
            kept.join("; ")
        }
        None => ours.clone(),
    };
    if let Ok(value) = HeaderValue::from_str(&policy) {
        headers.insert(CONTENT_SECURITY_POLICY, value);
    }
    headers.remove("x-frame-options");
}

fn forwarded(office: &Office, headers: &mut HeaderMap) {
    if let Ok(host) = HeaderValue::from_str(office.public_authority()) {
        headers.insert("x-forwarded-host", host);
    }
    if let Ok(proto) = HeaderValue::from_str(office.public_scheme()) {
        headers.insert("x-forwarded-proto", proto);
    }
}

async fn relay_http(office: Arc<Office>, ruchoir_origin: &str, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let path = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let mut builder = axum::http::Request::builder()
        .method(parts.method.clone())
        .uri(format!("{}{path}", office.engine_url()));
    if let Some(headers) = builder.headers_mut() {
        for (name, value) in parts.headers.iter() {
            if forwardable(name) {
                headers.append(name.clone(), value.clone());
            }
        }
        forwarded(&office, headers);
    }
    let Ok(upstream_request) = builder.body(body) else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    match office.client().request(upstream_request).await {
        Ok(upstream) => {
            let (mut parts, body) = upstream.into_parts();
            for name in DROPPED {
                parts.headers.remove(name);
            }
            parts.headers.remove(SET_COOKIE);
            frame_for(&mut parts.headers, ruchoir_origin);
            Response::from_parts(parts, Body::new(body))
        }
        Err(error) => {
            tracing::warn!(%error, "office engine unreachable");
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}

async fn relay_websocket(office: Arc<Office>, req: Request) -> Response {
    let (mut parts, _) = req.into_parts();
    let path = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str().to_owned())
        .unwrap_or_else(|| "/".to_owned());
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let url = format!("{}{path}", office.engine_url().replacen("http", "ws", 1));
    let Ok(mut request) = url.as_str().into_client_request() else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    forwarded(&office, request.headers_mut());
    let upstream = match tokio_tungstenite::connect_async(request).await {
        Ok((stream, _)) => stream,
        Err(error) => {
            tracing::warn!(%error, "office engine refused the co-editing socket");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    upgrade.on_upgrade(move |client| bridge(client, upstream))
}

/// Pump messages both ways until either side closes.
async fn bridge<S>(client: WebSocket, upstream: tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut client_tx, mut client_rx) = client.split();
    let (mut engine_tx, mut engine_rx) = upstream.split();
    let to_engine = async {
        while let Some(Ok(message)) = client_rx.next().await {
            let Some(message) = to_engine_message(message) else {
                break;
            };
            if engine_tx.send(message).await.is_err() {
                break;
            }
        }
        let _ = engine_tx.close().await;
    };
    let to_browser = async {
        while let Some(Ok(message)) = engine_rx.next().await {
            let Some(message) = to_browser_message(message) else {
                break;
            };
            if client_tx.send(message).await.is_err() {
                break;
            }
        }
        let _ = client_tx.close().await;
    };
    tokio::select! {
        _ = to_engine => {}
        _ = to_browser => {}
    }
}

fn to_engine_message(message: AxMessage) -> Option<TMessage> {
    Some(match message {
        AxMessage::Text(text) => TMessage::text(text.as_str()),
        AxMessage::Binary(bytes) => TMessage::binary(bytes),
        AxMessage::Ping(bytes) => TMessage::Ping(bytes),
        AxMessage::Pong(bytes) => TMessage::Pong(bytes),
        AxMessage::Close(_) => return None,
    })
}

fn to_browser_message(message: TMessage) -> Option<AxMessage> {
    Some(match message {
        TMessage::Text(text) => AxMessage::text(text.as_str()),
        TMessage::Binary(bytes) => AxMessage::binary(bytes),
        TMessage::Ping(bytes) => AxMessage::Ping(bytes),
        TMessage::Pong(bytes) => AxMessage::Pong(bytes),
        TMessage::Close(_) | TMessage::Frame(_) => return None,
    })
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_editor_paths_are_relayed() {
        for path in [
            "/hosting/wopi/word/edit",
            "/web-apps/apps/api/documents/api.js",
            "/cache/files/data/abc/Editor.bin",
            "/downloadfile/abc",
            "/printfile/abc",
            "/9.3.4-2344a07b03340e4cde66040c75fb8ae6/sdkjs/word/sdk-all-min.js",
            "/9.3.4-2344a07b03340e4cde66040c75fb8ae6/doc/abc/c/",
            "/9.3.4-2344a07b03340e4cde66040c75fb8ae6/themes.json",
            "/9.3.4-2344a07b03340e4cde66040c75fb8ae6/document_editor_service_worker.js",
        ] {
            assert!(allowed(path), "{path} is relayed");
        }
        for path in [
            "/",
            "/api/v1/health",
            "/hosting/discovery",
            "/example/",
            "/coauthoring/CommandService.ashx",
            "/converter",
            "/info/info.json",
            "/9.3.4/sdkjs/x.js",
            "/9.3.4-zz/sdkjs/x.js",
            "/9.3.4-abc/admin/",
            "/hosting/wopi/../../info/",
            "/web-apps/apps/%2e%2e/x",
            "/hosting/wopi/x%2F..%2F..%2F..%2Fadmin/",
            "/hosting/wopi/x%2f..%2fadmin/",
            "/9.3.4-abc/sdkjs/x%2F..%2F..%2Fcoauthoring/CommandService.ashx",
            "/hosting/wopi/x%5C..%5Cadmin/",
            "/hosting/wopi//admin/",
        ] {
            assert!(!allowed(path), "{path} is not relayed");
        }
    }

    #[test]
    fn the_editor_page_opens_only_this_instances_files() {
        let base = "http://api:8081";
        let ours =
            "WOPISrc=http%3A%2F%2Fapi%3A8081%2Fwopi%2Ffiles%2F0b8e4f2a-3c1d-4e5f-8a9b-0c1d2e3f4a5b";
        assert!(wopi_src_is_ours(
            "/hosting/wopi/word/edit",
            Some(&format!("ui=fr-FR&{ours}")),
            base
        ));
        assert!(wopi_src_is_ours(
            "/hosting/wopi/word/edit",
            Some(&ours.replace("WOPISrc", "wopisrc")),
            base
        ));
        assert!(
            wopi_src_is_ours("/web-apps/apps/api/documents/api.js", None, base),
            "other paths carry none"
        );
        for query in [
            None,
            Some("ui=fr-FR"),
            Some("WOPISrc=http%3A%2F%2Fevil.example%2Fwopi%2Ffiles%2F0b8e4f2a-3c1d-4e5f-8a9b-0c1d2e3f4a5b"),
            Some("WOPISrc=http%3A%2F%2F192.168.1.1%2Fadmin"),
            Some("WOPISrc=http%3A%2F%2Fapi%3A8081%2Fwopi%2Ffiles%2Fnot-a-uuid"),
            Some("WOPISrc=http%3A%2F%2Fapi%3A8081%2Fwopi%2Ffiles%2F0b8e4f2a-3c1d-4e5f-8a9b-0c1d2e3f4a5b%2F..%2Fx"),
            Some("WOPISrc=http%3A%2F%2Fapi%3A8081%2Fwopi%2Ffiles%2F0b8e4f2a-3c1d-4e5f-8a9b-0c1d2e3f4a5b&WOPISrc=http%3A%2F%2Fevil.example"),
        ] {
            assert!(!wopi_src_is_ours("/hosting/wopi/word/edit", query, base), "{query:?} is refused");
        }
    }

    #[test]
    fn no_credential_reaches_the_engine() {
        for name in [
            "cookie",
            "authorization",
            "host",
            "connection",
            "upgrade",
            "x-forwarded-host",
        ] {
            assert!(
                !forwardable(&HeaderName::from_static(name)),
                "{name} is dropped"
            );
        }
        assert!(forwardable(&HeaderName::from_static("accept")));
    }

    #[test]
    fn the_engine_pages_may_be_framed_by_ruchoir_only() {
        let mut headers = HeaderMap::new();
        frame_for(&mut headers, "https://ruchoir.example.org");
        assert_eq!(
            headers[CONTENT_SECURITY_POLICY],
            "frame-ancestors https://ruchoir.example.org"
        );

        let mut headers = HeaderMap::new();
        headers.insert(
            CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'self'; frame-ancestors 'self'"),
        );
        headers.insert("x-frame-options", HeaderValue::from_static("SAMEORIGIN"));
        frame_for(&mut headers, "https://ruchoir.example.org");
        assert_eq!(
            headers[CONTENT_SECURITY_POLICY],
            "default-src 'self'; frame-ancestors https://ruchoir.example.org"
        );
        assert!(headers.get("x-frame-options").is_none());
    }
}
