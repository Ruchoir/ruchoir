//! The rules of the app's own protocol, `ruchoir-app://localhost/`.
//!
//! One origin serves the interface, every instance's API and the emoji, so the web client runs
//! same-origin (no CORS, and the emoji sprite's `<use href>` works, which a second origin forbids):
//!
//! - `/i/<instance-id>/api/v1/...` goes to that instance, with its bearer;
//! - `/api/v1/...` goes to the open instance, with its bearer: the paths the server hands out as they
//!   are (an avatar, a space's icon), which the interface uses without its `/i/<id>` base;
//! - `/emoji/...` goes to a signed-in instance, without one;
//! - anything else is the embedded interface.
//!
//! Upstream, the proxy never sends `Origin` or a cookie (the instance would take the request for a
//! browser's and refuse a token), and it never passes `Set-Cookie` back.

use reqwest::header::{HeaderMap, HeaderName, AUTHORIZATION};
use reqwest::Method;

/// Where a path of the app's protocol goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// An instance's API: `rest` starts with `/api/v1/`.
    Api { instance: String, rest: String },
    /// The open instance's API, by a path the server returned without the app's base.
    OpenApi(String),
    /// The emoji pack, the same on every instance.
    Emoji(String),
    /// The embedded interface.
    Asset(String),
}

/// Sort a path of the app's protocol.
pub fn route(path: &str) -> Route {
    if let Some(after) = path.strip_prefix("/i/") {
        if let Some((instance, rest)) = after.split_once('/') {
            let plausible =
                !instance.is_empty() && instance.bytes().all(|b| b.is_ascii_alphanumeric());
            let rest = format!("/{rest}");
            if plausible && rest.starts_with("/api/v1/") {
                return Route::Api {
                    instance: instance.to_string(),
                    rest,
                };
            }
        }
    }
    if path.starts_with("/api/v1/") {
        return Route::OpenApi(path.to_string());
    }
    if path.starts_with("/emoji/") {
        return Route::Emoji(path.to_string());
    }
    Route::Asset(path.to_string())
}

/// The request headers passed upstream; everything else (`Origin`, `Cookie`, `Sec-Fetch-*`, the
/// webview's own) stays behind. Conditional headers too: the webview keeps no cache of the app's
/// protocol, so an upstream 304 would reach it with an empty body.
const UPSTREAM: [&str; 5] = [
    "accept",
    "accept-language",
    "content-type",
    "range",
    "x-requested-with",
];

/// The response headers kept back from the interface.
const KEPT_BACK: [&str; 11] = [
    "set-cookie",
    "strict-transport-security",
    "content-security-policy",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Build the request to the instance. `path_and_query` is the instance-relative path
/// (`/api/v1/...` or `/emoji/...`); `token` is given for the API only.
pub fn upstream_request(
    http: &reqwest::Client,
    method: Method,
    path_and_query: &str,
    headers: &HeaderMap,
    body: Vec<u8>,
    origin: &str,
    token: Option<&str>,
) -> reqwest::Result<reqwest::Request> {
    let mut builder = http.request(method, format!("{origin}{path_and_query}"));
    for name in UPSTREAM {
        if let Some(value) = headers.get(name) {
            builder = builder.header(name, value);
        }
    }
    if let Some(token) = token {
        builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    if !body.is_empty() {
        builder = builder.body(body);
    }
    builder.build()
}

/// The instance's response headers the interface may see.
pub fn downstream_headers(upstream: &HeaderMap) -> HeaderMap {
    let mut kept = HeaderMap::new();
    for (name, value) in upstream {
        if !KEPT_BACK.contains(&name.as_str()) {
            kept.append(HeaderName::clone(name), value.clone());
        }
    }
    kept
}

/// What a response means for the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Normal,
    /// The instance no longer knows the session: forget the token.
    SignedOut,
    /// The person signed out from the interface (here, or everywhere): forget the token.
    LoggedOut,
}

/// What a response means for the session, from its path, method and status alone.
pub fn outcome(rest: &str, method: &Method, status: u16) -> Outcome {
    if status == 401 {
        return Outcome::SignedOut;
    }
    let signing_out = rest == "/api/v1/auth/logout" || rest == "/api/v1/auth/logout/all";
    if method == Method::POST && signing_out && (200..300).contains(&status) {
        return Outcome::LoggedOut;
    }
    Outcome::Normal
}

/// `outcome`, reading the body of a 401: `invalid_credentials` is a wrong password typed to confirm
/// an action, not a session that ended.
pub fn outcome_with_body(rest: &str, method: &Method, status: u16, body: &[u8]) -> Outcome {
    if status == 401 {
        let code = serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
        if code.as_deref() == Some("invalid_credentials") {
            return Outcome::Normal;
        }
    }
    outcome(rest, method, status)
}

/// A whole response, as Tauri's protocol responder takes it (it has no streaming body).
#[derive(Debug)]
pub struct Answer {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

/// Send a request to the instance and bring its answer back. An instance that cannot be reached
/// answers 502, which the interface shows as being offline; it is never taken for a sign-out.
pub async fn forward(
    http: &reqwest::Client,
    method: Method,
    path_and_query: &str,
    headers: &HeaderMap,
    body: Vec<u8>,
    origin: &str,
    token: Option<&str>,
) -> Answer {
    let unreachable = || Answer {
        status: 502,
        headers: HeaderMap::new(),
        body: Vec::new(),
    };
    let Ok(request) = upstream_request(http, method, path_and_query, headers, body, origin, token)
    else {
        return unreachable();
    };
    let Ok(response) = http.execute(request).await else {
        return unreachable();
    };
    let status = response.status().as_u16();
    let headers = downstream_headers(response.headers());
    match response.bytes().await {
        Ok(bytes) => Answer {
            status,
            headers,
            body: bytes.to_vec(),
        },
        Err(_) => unreachable(),
    }
}

/// The emoji pack's files, kept in memory once fetched: the same on every instance, and asked again
/// and again by the interface (the webview keeps no cache of the app's protocol). Only successful
/// answers, within a size bound; the oldest go first.
#[derive(Debug)]
pub struct EmojiCache {
    capacity: usize,
    size: usize,
    entries: std::collections::VecDeque<(String, Answer)>,
}

impl EmojiCache {
    /// A cache holding at most `capacity` bytes of bodies.
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            size: 0,
            entries: std::collections::VecDeque::new(),
        }
    }

    /// A kept answer for `path`.
    pub fn get(&self, path: &str) -> Option<Answer> {
        self.entries
            .iter()
            .find(|(p, _)| p == path)
            .map(|(_, a)| Answer {
                status: a.status,
                headers: a.headers.clone(),
                body: a.body.clone(),
            })
    }

    /// Keep `answer` for `path` if it is a success that fits.
    pub fn put(&mut self, path: &str, answer: &Answer) {
        if answer.status != 200 || answer.body.len() > self.capacity || self.get(path).is_some() {
            return;
        }
        while self.size + answer.body.len() > self.capacity {
            match self.entries.pop_front() {
                Some((_, old)) => self.size -= old.body.len(),
                None => break,
            }
        }
        self.size += answer.body.len();
        self.entries.push_back((
            path.to_string(),
            Answer {
                status: answer.status,
                headers: answer.headers.clone(),
                body: answer.body.clone(),
            },
        ));
    }
}
