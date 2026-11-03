//! End-to-end tests for the preferences that follow an account (`/me/preferences`) and for the
//! hidden direct conversations. Same harness as the parent module, same skip rule.

use super::*;

use crate::entities::user_preferences;

const PATH: &str = "/api/v1/me/preferences";

async fn read(app: &TestApp, cookie: &str) -> Value {
    let response = app
        .req(reqwest::Method::GET, PATH, cookie)
        .send()
        .await
        .expect("get");
    assert_eq!(response.status(), 200);
    response.json().await.expect("json")
}

async fn patch(app: &TestApp, cookie: &str, body: Value) -> reqwest::Response {
    app.req(reqwest::Method::PATCH, PATH, cookie)
        .json(&body)
        .send()
        .await
        .expect("patch")
}

/// Assert no event of `event_type` arrives within a short window; anything else is ignored.
async fn expect_no_event(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>, event_type: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(800);
    while let Ok(Some(frame)) = tokio::time::timeout_at(deadline, ws.next()).await {
        let Ok(WsMessage::Text(text)) = frame else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<Value>(text.as_str()) else {
            continue;
        };
        assert_ne!(event["type"], event_type, "unexpected event: {text}");
    }
}

#[tokio::test]
async fn an_account_without_preferences_reads_an_empty_document() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    assert_eq!(read(&app, &alice).await, json!({}));
}

#[tokio::test]
async fn patch_then_read_back() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;

    let response = patch(&app, &alice, json!({ "locale": "en", "font": "dyslexic" })).await;
    assert_eq!(response.status(), 200);
    let answered: Value = response.json().await.expect("json");
    assert_eq!(answered, json!({ "locale": "en", "font": "dyslexic" }));
    assert_eq!(read(&app, &alice).await, answered);

    // The font lands in its typed column, the rest in `ui_state`.
    let row = user_preferences::Entity::find_by_id(fx.alice)
        .one(&app.db)
        .await
        .expect("query")
        .expect("row");
    assert_eq!(row.font.as_deref(), Some("dyslexic"));
    let ui_state: Value =
        serde_json::from_str(row.ui_state.as_deref().expect("ui_state")).expect("ui_state json");
    assert_eq!(ui_state, json!({ "locale": "en" }));
}

#[tokio::test]
async fn patch_keeps_keys_it_does_not_name() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let order = json!([fx.space_id.to_string()]);

    assert_eq!(
        patch(&app, &alice, json!({ "space_order": order }))
            .await
            .status(),
        200
    );
    // A second device, which knows only the language, changes it.
    assert_eq!(
        patch(&app, &alice, json!({ "locale": "pl" }))
            .await
            .status(),
        200
    );
    assert_eq!(
        read(&app, &alice).await,
        json!({ "space_order": order, "locale": "pl" })
    );
}

#[tokio::test]
async fn null_removes_a_key() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;

    patch(
        &app,
        &alice,
        json!({ "locale": "en", "emoji_animated": false }),
    )
    .await;
    let response = patch(
        &app,
        &alice,
        json!({ "locale": null, "emoji_animated": null }),
    )
    .await;
    assert_eq!(response.status(), 200);
    assert_eq!(read(&app, &alice).await, json!({}));
}

#[tokio::test]
async fn an_invalid_value_is_refused_and_nothing_changes() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    patch(&app, &alice, json!({ "locale": "en" })).await;

    // One bad key refuses the whole change, the good one beside it included.
    let refused = patch(
        &app,
        &alice,
        json!({ "locale": "de", "calendar_open_at": 30 }),
    )
    .await;
    assert_eq!(refused.status(), 400);
    let body: Value = refused.json().await.expect("json");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .starts_with("calendar_open_at:"),
        "{body}"
    );
    // The theme is the device's own.
    assert_eq!(
        patch(&app, &alice, json!({ "theme": "mint" }))
            .await
            .status(),
        400
    );
    // A working day that would end before it starts, across two requests.
    assert_eq!(
        patch(&app, &alice, json!({ "calendar_work_end": 18 }))
            .await
            .status(),
        200
    );
    assert_eq!(
        patch(&app, &alice, json!({ "calendar_work_start": 20 }))
            .await
            .status(),
        400
    );

    assert_eq!(
        read(&app, &alice).await,
        json!({ "locale": "en", "calendar_work_end": 18 })
    );
}

#[tokio::test]
async fn preferences_belong_to_their_owner() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;

    patch(&app, &alice, json!({ "locale": "it" })).await;
    assert_eq!(read(&app, &bob).await, json!({}));
    // And without a session, nothing at all.
    let anonymous = app
        .http
        .get(format!("{}{PATH}", app.base))
        .send()
        .await
        .expect("get");
    assert_eq!(anonymous.status(), 401);
}

#[tokio::test]
async fn a_change_reaches_only_the_owners_connections() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let mut laptop = app.connect_ws(&alice).await;
    let mut phone = app.connect_ws(&alice).await;
    let mut bob_ws = app.connect_ws(&bob).await;

    patch(&app, &alice, json!({ "locale": "en" })).await;

    for ws in [&mut laptop, &mut phone] {
        let event = wait_for_type(ws, "preferences.updated").await;
        assert_eq!(event["payload"]["changes"], json!({ "locale": "en" }));
    }
    expect_no_event(&mut bob_ws, "preferences.updated").await;

    // A removal says so with a null, which the devices read as "back to the default".
    patch(&app, &alice, json!({ "locale": null })).await;
    let event = wait_for_type(&mut laptop, "preferences.updated").await;
    assert_eq!(event["payload"]["changes"], json!({ "locale": null }));
}
