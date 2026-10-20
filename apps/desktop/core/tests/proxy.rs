//! The proxy's rules, and a forward to an instance that is not there.

use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::Method;
use ruchoir_desktop_core::proxy::{
    downstream_headers, forward, outcome, route, upstream_request, Outcome, Route,
};

#[test]
fn routes() {
    assert_eq!(
        route("/i/abc/api/v1/me"),
        Route::Api {
            instance: "abc".into(),
            rest: "/api/v1/me".into()
        }
    );
    assert_eq!(
        route("/emoji/sprite.svg"),
        Route::Emoji("/emoji/sprite.svg".into())
    );
    assert_eq!(route("/e/s/c/x"), Route::Asset("/e/s/c/x".into()));
    assert_eq!(route("/apiary"), Route::Asset("/apiary".into()));
    assert_eq!(
        route("/i/abc/elsewhere"),
        Route::Asset("/i/abc/elsewhere".into())
    );
    assert_eq!(route("/i//api/v1/me"), Route::Asset("/i//api/v1/me".into()));
    assert_eq!(
        route("/i/../api/v1/me"),
        Route::Asset("/i/../api/v1/me".into())
    );
}

fn browser_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "origin",
        HeaderValue::from_static("ruchoir-app://localhost"),
    );
    headers.insert("cookie", HeaderValue::from_static("a=b"));
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers.insert("accept-language", HeaderValue::from_static("fr"));
    headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
    headers
}

#[test]
fn upstream_strips_origin_and_cookie_and_adds_bearer() {
    let request = upstream_request(
        &reqwest::Client::new(),
        Method::POST,
        "/api/v1/messages?x=1",
        &browser_headers(),
        b"{}".to_vec(),
        "https://a.example",
        Some("t"),
    )
    .unwrap();
    assert_eq!(
        request.url().as_str(),
        "https://a.example/api/v1/messages?x=1"
    );
    let headers = request.headers();
    assert!(headers.get("origin").is_none());
    assert!(headers.get("cookie").is_none());
    assert!(headers.get("sec-fetch-site").is_none());
    assert_eq!(headers.get("authorization").unwrap(), "Bearer t");
    assert_eq!(headers.get("content-type").unwrap(), "application/json");
    assert_eq!(headers.get("accept-language").unwrap(), "fr");
}

#[test]
fn emoji_never_carries_bearer() {
    let request = upstream_request(
        &reqwest::Client::new(),
        Method::GET,
        "/emoji/sprite.svg",
        &browser_headers(),
        Vec::new(),
        "https://a.example",
        None,
    )
    .unwrap();
    assert!(request.headers().get("authorization").is_none());
}

#[test]
fn downstream_drops_set_cookie() {
    let mut upstream = HeaderMap::new();
    upstream.insert("set-cookie", HeaderValue::from_static("__Host-s=1"));
    upstream.insert(
        "strict-transport-security",
        HeaderValue::from_static("max-age=1"),
    );
    upstream.insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'none'"),
    );
    upstream.insert("connection", HeaderValue::from_static("keep-alive"));
    upstream.insert("content-type", HeaderValue::from_static("application/json"));
    upstream.insert("etag", HeaderValue::from_static("\"1\""));
    let down = downstream_headers(&upstream);
    assert!(down.get("set-cookie").is_none());
    assert!(down.get("strict-transport-security").is_none());
    assert!(down.get("content-security-policy").is_none());
    assert!(down.get("connection").is_none());
    assert_eq!(down.get("content-type").unwrap(), "application/json");
    assert_eq!(down.get("etag").unwrap(), "\"1\"");
}

#[test]
fn outcomes() {
    assert_eq!(outcome("/api/v1/me", &Method::GET, 401), Outcome::SignedOut);
    assert_eq!(
        outcome("/api/v1/auth/logout", &Method::POST, 204),
        Outcome::LoggedOut
    );
    assert_eq!(
        outcome("/api/v1/auth/logout", &Method::POST, 500),
        Outcome::Normal
    );
    assert_eq!(outcome("/api/v1/me", &Method::GET, 200), Outcome::Normal);
}

#[test]
fn logout_success_forgets_token() {
    assert_eq!(
        outcome("/api/v1/auth/logout", &Method::POST, 200),
        Outcome::LoggedOut
    );
}

#[test]
fn a_wrong_password_to_confirm_an_action_is_not_a_sign_out() {
    // The client says so on its side too (`onUnauthorized(code)`); the proxy reads the code.
    assert_eq!(
        ruchoir_desktop_core::proxy::outcome_with_body(
            "/api/v1/me/password",
            &Method::POST,
            401,
            br#"{"error":"invalid_credentials"}"#
        ),
        Outcome::Normal
    );
}

#[tokio::test]
async fn upstream_unreachable_is_502_not_signed_out() {
    // A port nothing listens on.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let answer = forward(
        &reqwest::Client::new(),
        Method::GET,
        "/api/v1/me",
        &HeaderMap::new(),
        Vec::new(),
        &format!("http://127.0.0.1:{port}"),
        Some("t"),
    )
    .await;
    assert_eq!(answer.status, 502);
    assert_eq!(
        outcome("/api/v1/me", &Method::GET, answer.status),
        Outcome::Normal
    );
}
