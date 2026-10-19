//! End-to-end tests for native sessions: the bearer token a mobile app keeps in its keychain
//! instead of a cookie. Same harness as the parent module, same skip rule.

use super::*;

use crate::entities::recovery_codes;

const PASSWORD: &str = "Correct-Horse-42!";

/// An active account that signs in with [`PASSWORD`]; returns its id and address.
async fn make_password_user(app: &TestApp, mfa: bool) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let email = format!("native-{}@example.test", id.simple());
    let hash = crate::auth::password::hash_password(&app.config, PASSWORD).expect("hash");
    users::ActiveModel {
        id: Set(id),
        email: Set(email.clone()),
        display_name: Set("Native".to_owned()),
        password_hash: Set(Some(hash)),
        status: Set("active".to_owned()),
        mfa_enforced: Set(mfa),
        is_bot: Set(false),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("user");
    (id, email)
}

/// `POST /auth/login` asking for a token, as the app does.
async fn native_login(app: &TestApp, email: &str) -> reqwest::Response {
    app.http
        .post(format!("{}/api/v1/auth/login", app.base))
        .json(&json!({ "email": email, "password": PASSWORD, "session_delivery": "token" }))
        .send()
        .await
        .expect("login")
}

/// A token from a native login, for the tests that only need one.
async fn token_for(app: &TestApp, email: &str) -> String {
    let response = native_login(app, email).await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("json");
    body["session_token"]
        .as_str()
        .expect("a token in the body")
        .to_owned()
}

async fn session_status(app: &TestApp, authorization: &str) -> u16 {
    app.http
        .get(format!("{}/api/v1/auth/session", app.base))
        .header(reqwest::header::AUTHORIZATION, authorization)
        .send()
        .await
        .expect("session")
        .status()
        .as_u16()
}

#[tokio::test]
async fn a_native_login_receives_a_token_and_no_cookie() {
    let Some(app) = boot().await else { return };
    let (_, email) = make_password_user(&app, false).await;

    let response = native_login(&app, &email).await;
    assert_eq!(response.status(), 200);
    assert!(
        response
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .is_none(),
        "a token replaces the cookie, it does not come with one"
    );
    let body: Value = response.json().await.expect("json");
    assert!(body["session_token"]
        .as_str()
        .is_some_and(|t| !t.is_empty()));
    assert_eq!(body["email"], email);
}

#[tokio::test]
async fn a_bearer_token_opens_the_session_and_the_socket() {
    let Some(app) = boot().await else { return };
    let (id, email) = make_password_user(&app, false).await;
    let token = token_for(&app, &email).await;

    let me: Value = app
        .http
        .get(format!("{}/api/v1/auth/session", app.base))
        .bearer_auth(&token)
        .send()
        .await
        .expect("session")
        .json()
        .await
        .expect("json");
    assert_eq!(me["id"], id.to_string());

    // The realtime socket authenticates on its upgrade request, with the same header.
    let mut request = app
        .ws_url
        .as_str()
        .into_client_request()
        .expect("ws request");
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {token}").parse().expect("header"),
    );
    assert!(
        tokio_tungstenite::connect_async(request).await.is_ok(),
        "the socket accepts the bearer"
    );
    let anonymous = app
        .ws_url
        .as_str()
        .into_client_request()
        .expect("ws request");
    assert!(
        tokio_tungstenite::connect_async(anonymous).await.is_err(),
        "and still refuses a request without one"
    );
}

#[tokio::test]
async fn a_browser_cannot_ask_for_a_token() {
    let Some(app) = boot().await else { return };
    let (_, email) = make_password_user(&app, false).await;

    // A script running in the web app itself: its own origin passes `same_site_guard`, so the login
    // route is what must refuse to hand it a token it could carry away.
    let own_origin = app.config.public_origin();
    for (name, value) in [
        ("origin", own_origin.as_str()),
        ("sec-fetch-site", "same-origin"),
    ] {
        let response = app
            .http
            .post(format!("{}/api/v1/auth/login", app.base))
            .header(name, value)
            .json(&json!({ "email": email, "password": PASSWORD, "session_delivery": "token" }))
            .send()
            .await
            .expect("login");
        assert_eq!(response.status(), 400, "{name} marks a browser");
        assert!(response
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .is_none());
        let body: Value = response.json().await.expect("json");
        assert_eq!(body["error"], "token_from_browser");
    }
}

#[tokio::test]
async fn a_second_factor_delivers_the_token_chosen_at_login() {
    let Some(app) = boot().await else { return };
    let (id, email) = make_password_user(&app, true).await;
    recovery_codes::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(id),
        code_hash: Set(crate::auth::recovery::hash_code(
            &[0x11; 32],
            "abcd-efgh-jkmn",
        )),
        used_at: Set(None),
        created_at: Set(OffsetDateTime::now_utc()),
    }
    .insert(&app.db)
    .await
    .expect("recovery code");

    let challenge: Value = native_login(&app, &email).await.json().await.expect("json");
    assert_eq!(challenge["mfa_required"], true);
    assert!(challenge.get("session_token").is_none());

    let response = app
        .http
        .post(format!("{}/api/v1/auth/mfa/recovery/verify", app.base))
        .json(&json!({ "mfa_token": challenge["mfa_token"], "code": "abcd-efgh-jkmn" }))
        .send()
        .await
        .expect("verify");
    assert_eq!(response.status(), 200);
    assert!(response
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .is_none());
    let body: Value = response.json().await.expect("json");
    let token = body["session_token"].as_str().expect("token");
    assert_eq!(session_status(&app, &format!("Bearer {token}")).await, 200);
}

#[tokio::test]
async fn logging_out_with_a_bearer_ends_that_session() {
    let Some(app) = boot().await else { return };
    let (_, email) = make_password_user(&app, false).await;
    let token = token_for(&app, &email).await;

    let response = app
        .http
        .post(format!("{}/api/v1/auth/logout", app.base))
        .bearer_auth(&token)
        .send()
        .await
        .expect("logout");
    assert_eq!(response.status(), 204);
    assert_eq!(session_status(&app, &format!("Bearer {token}")).await, 401);
}

#[tokio::test]
async fn a_malformed_authorization_is_unauthorized() {
    let Some(app) = boot().await else { return };
    let (_, email) = make_password_user(&app, false).await;
    let token = token_for(&app, &email).await;

    assert_eq!(session_status(&app, "Bearer").await, 401);
    assert_eq!(session_status(&app, &format!("Basic {token}")).await, 401);
    assert_eq!(session_status(&app, "Bearer not-a-session").await, 401);
}

#[tokio::test]
async fn the_instance_announces_native_sessions() {
    let Some(app) = boot().await else { return };
    let instance: Value = app
        .http
        .get(format!("{}/api/v1/instance", app.base))
        .send()
        .await
        .expect("instance")
        .json()
        .await
        .expect("json");
    assert_eq!(instance["native_sessions"], true);
}

// --- Handing a session between the web page and the app (step 6f) ---

/// RFC 7636's example verifier, and its SHA-256 in hex: the challenge the app would send.
const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE: &str = "13d31e961a1ad8ec2f16b10c4c982e0876a878ad6df144566ee1894acb70f9c3";

/// `POST /auth/native/code` from a signed-in page (a bearer stands in for the cookie here).
async fn native_code(app: &TestApp, token: &str, challenge: &str) -> reqwest::Response {
    app.http
        .post(format!("{}/api/v1/auth/native/code", app.base))
        .bearer_auth(token)
        .json(&json!({ "challenge": challenge }))
        .send()
        .await
        .expect("native code")
}

async fn code_from(response: reqwest::Response) -> String {
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("json");
    body["code"].as_str().expect("a code").to_owned()
}

async fn exchange(app: &TestApp, code: &str, verifier: &str) -> reqwest::Response {
    app.http
        .post(format!("{}/api/v1/auth/native/exchange", app.base))
        .json(&json!({ "code": code, "verifier": verifier }))
        .send()
        .await
        .expect("exchange")
}

#[tokio::test]
async fn a_native_code_and_its_verifier_open_a_session_of_the_app() {
    let Some(app) = boot().await else { return };
    let (id, email) = make_password_user(&app, false).await;
    let page = token_for(&app, &email).await;
    let code = code_from(native_code(&app, &page, CHALLENGE).await).await;

    let response = exchange(&app, &code, VERIFIER).await;
    assert_eq!(response.status(), 200);
    assert!(response
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .is_none());
    let body: Value = response.json().await.expect("json");
    assert_eq!(body["id"], id.to_string());
    let token = body["session_token"].as_str().expect("a token").to_owned();
    assert_ne!(token, page, "the app gets a session of its own");
    assert_eq!(session_status(&app, &format!("Bearer {token}")).await, 200);
}

#[tokio::test]
async fn a_native_code_serves_once() {
    let Some(app) = boot().await else { return };
    let (_, email) = make_password_user(&app, false).await;
    let page = token_for(&app, &email).await;
    let code = code_from(native_code(&app, &page, CHALLENGE).await).await;

    assert_eq!(exchange(&app, &code, VERIFIER).await.status(), 200);
    assert_eq!(exchange(&app, &code, VERIFIER).await.status(), 400);
}

#[tokio::test]
async fn the_wrong_verifier_opens_nothing_and_spends_the_code() {
    let Some(app) = boot().await else { return };
    let (_, email) = make_password_user(&app, false).await;
    let page = token_for(&app, &email).await;
    let code = code_from(native_code(&app, &page, CHALLENGE).await).await;

    let wrong = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXK";
    assert_eq!(exchange(&app, &code, wrong).await.status(), 400);
    // Whoever saw the code gets one guess, and it is gone after it.
    assert_eq!(exchange(&app, &code, VERIFIER).await.status(), 400);
}

#[tokio::test]
async fn a_browser_cannot_exchange_a_native_code() {
    let Some(app) = boot().await else { return };
    let (_, email) = make_password_user(&app, false).await;
    let page = token_for(&app, &email).await;
    let code = code_from(native_code(&app, &page, CHALLENGE).await).await;

    // The web app's own page, which `same_site_guard` lets through: the route itself must refuse.
    let own_origin = app.config.public_origin();
    let response = app
        .http
        .post(format!("{}/api/v1/auth/native/exchange", app.base))
        .header(reqwest::header::ORIGIN, own_origin.as_str())
        .json(&json!({ "code": code, "verifier": VERIFIER }))
        .send()
        .await
        .expect("exchange");
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.expect("json");
    assert_eq!(body["error"], "token_from_browser");
    // Refused before the code was looked at: the app can still use it.
    assert_eq!(exchange(&app, &code, VERIFIER).await.status(), 200);
}

#[tokio::test]
async fn a_native_code_takes_a_challenge_and_a_session() {
    let Some(app) = boot().await else { return };
    let (_, email) = make_password_user(&app, false).await;
    let page = token_for(&app, &email).await;

    assert_eq!(native_code(&app, &page, "abc").await.status(), 400);
    let anonymous = app
        .http
        .post(format!("{}/api/v1/auth/native/code", app.base))
        .json(&json!({ "challenge": CHALLENGE }))
        .send()
        .await
        .expect("native code");
    assert_eq!(anonymous.status(), 401);
}

#[tokio::test]
async fn a_web_handoff_opens_a_browser_session_once() {
    let Some(app) = boot().await else { return };
    let (_, email) = make_password_user(&app, false).await;
    let token = token_for(&app, &email).await;

    let code = code_from(
        app.http
            .post(format!("{}/api/v1/auth/web/handoff", app.base))
            .bearer_auth(&token)
            .send()
            .await
            .expect("handoff"),
    )
    .await;
    let redeem = || {
        app.http
            .post(format!("{}/api/v1/auth/web/redeem", app.base))
            .json(&json!({ "code": code }))
            .send()
    };
    let response = redeem().await.expect("redeem");
    assert_eq!(response.status(), 200);
    let cookie = response
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .expect("a session cookie")
        .to_owned();
    assert!(cookie.starts_with("__Host-"), "the hardened session cookie");
    assert_eq!(redeem().await.expect("redeem").status(), 400);

    let anonymous = app
        .http
        .post(format!("{}/api/v1/auth/web/handoff", app.base))
        .send()
        .await
        .expect("handoff");
    assert_eq!(anonymous.status(), 401);
}
