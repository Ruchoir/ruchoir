//! A per-person rate limit on the sensitive authenticated routes.

use super::*;

#[tokio::test]
async fn a_burst_on_the_sensitive_routes_is_answered_429() {
    let Some(app) = boot_with(None, |config| {
        config.sensitive_rate_burst = 5;
        config.sensitive_rate_period_ms = 60_000;
    })
    .await
    else {
        return;
    };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Limits").await;
    let other = make_user(&app.db, "other").await;
    crate::testkit::add_member(&app.db, space, other, "member").await;
    let cookie = app.cookie_for(owner).await;
    let mut codes = Vec::new();
    for _ in 0..8 {
        let response = app
            .req(
                reqwest::Method::GET,
                &format!("/api/v1/spaces/{space}/audit"),
                &cookie,
            )
            .send()
            .await
            .expect("audit");
        codes.push(response.status().as_u16());
    }
    assert!(codes[..5].iter().all(|code| *code == 200), "{codes:?}");
    assert!(codes[5..].iter().all(|code| *code == 429), "{codes:?}");

    // The bucket is the person's: someone else is not slowed by it.
    let response = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{space}/groups"),
            &app.cookie_for(other).await,
        )
        .send()
        .await
        .expect("groups");
    assert_ne!(response.status().as_u16(), 429);
    // The shared bucket also covers the other sensitive routes.
    let response = app
        .req(reqwest::Method::GET, "/api/v1/imports", &cookie)
        .send()
        .await
        .expect("imports");
    assert_eq!(response.status().as_u16(), 429);
    // Ordinary routes are not limited.
    let response = app
        .req(reqwest::Method::GET, "/api/v1/me/spaces", &cookie)
        .send()
        .await
        .expect("spaces");
    assert_ne!(response.status().as_u16(), 429);
}

async fn statuses(
    app: &TestApp,
    method: reqwest::Method,
    path: &str,
    cookie: &str,
    times: usize,
) -> Vec<u16> {
    let mut codes = Vec::new();
    for _ in 0..times {
        let response = app
            .req(method.clone(), path, cookie)
            .send()
            .await
            .expect("request");
        codes.push(response.status().as_u16());
    }
    codes
}

#[tokio::test]
async fn the_plain_reads_of_the_screens_have_a_looser_bucket_of_their_own() {
    let Some(app) = boot_with(None, |config| {
        config.sensitive_rate_burst = 5;
        config.sensitive_rate_period_ms = 60_000;
        config.read_rate_burst = 30;
        config.read_rate_period_ms = 60_000;
    })
    .await
    else {
        return;
    };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Reads").await;
    let cookie = app.cookie_for(owner).await;
    // Twenty reloads of the roles, the groups and the access of a channel: never a 429.
    for path in [
        format!("/api/v1/spaces/{space}/roles"),
        format!("/api/v1/spaces/{space}/groups"),
    ] {
        let codes = statuses(&app, reqwest::Method::GET, &path, &cookie, 10).await;
        assert!(codes.iter().all(|code| *code != 429), "{path}: {codes:?}");
    }
    // The strict bucket is untouched by them: the journal still gets its five.
    let audit = format!("/api/v1/spaces/{space}/audit");
    let codes = statuses(&app, reqwest::Method::GET, &audit, &cookie, 7).await;
    assert!(codes[..5].iter().all(|code| *code == 200), "{codes:?}");
    assert!(codes[5..].iter().all(|code| *code == 429), "{codes:?}");
    // The reads bucket has its own end.
    let codes = statuses(
        &app,
        reqwest::Method::GET,
        &format!("/api/v1/spaces/{space}/roles"),
        &cookie,
        30,
    )
    .await;
    assert_eq!(codes.last().copied(), Some(429), "{codes:?}");
    // A write is strict: the exhausted bucket answers it 429.
    let write = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{space}/groups"),
            &cookie,
        )
        .json(&json!({ "name": "Late" }))
        .send()
        .await
        .expect("write");
    assert_eq!(write.status().as_u16(), 429);
}

#[tokio::test]
async fn made_up_cookies_share_the_address_bucket_and_the_tools_are_not_limited() {
    let Some(app) = boot_with(None, |config| {
        config.sensitive_rate_burst = 5;
        config.sensitive_rate_period_ms = 60_000;
    })
    .await
    else {
        return;
    };
    let space = Uuid::new_v4();
    let mut codes = Vec::new();
    for _ in 0..9 {
        // A fresh made-up session each time: with a key per cookie none would ever be counted twice.
        let forged = format!("{SESSION_COOKIE}={}", Uuid::new_v4().simple());
        let response = app
            .http
            .get(format!("{}/api/v1/spaces/{space}/audit", app.base))
            .header("cookie", forged)
            .send()
            .await
            .expect("request");
        codes.push(response.status().as_u16());
    }
    assert!(codes.contains(&429), "{codes:?}");
    // The served tools are public downloads, outside the limit however often they are fetched.
    for _ in 0..12 {
        let response = app
            .http
            .get(format!("{}/tools/export-nextcloud.sh", app.base))
            .send()
            .await
            .expect("tool");
        assert_eq!(response.status().as_u16(), 200);
    }
}
