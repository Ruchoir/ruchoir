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
