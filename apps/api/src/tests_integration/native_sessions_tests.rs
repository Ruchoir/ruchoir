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
