//! Sharing a personal calendar: with whom, at which level, and what each level shows.

use super::*;

async fn personal(app: &TestApp, cookie: &str) -> Value {
    calendars_of(app, cookie)
        .await
        .into_iter()
        .find(|c| c["space_id"].is_null() && c["is_default"] == true)
        .expect("personal calendar")
}

async fn share(
    app: &TestApp,
    cookie: &str,
    calendar: &Value,
    user: Uuid,
    level: &str,
) -> reqwest::StatusCode {
    app.req(
        reqwest::Method::PUT,
        &format!(
            "/api/v1/calendars/{}/shares/{user}",
            calendar["id"].as_str().unwrap()
        ),
        cookie,
    )
    .json(&json!({ "level": level }))
    .send()
    .await
    .expect("share")
    .status()
}

async fn unshare(app: &TestApp, cookie: &str, calendar: &Value, user: Uuid) -> reqwest::StatusCode {
    app.req(
        reqwest::Method::DELETE,
        &format!(
            "/api/v1/calendars/{}/shares/{user}",
            calendar["id"].as_str().unwrap()
        ),
        cookie,
    )
    .send()
    .await
    .expect("unshare")
    .status()
}

async fn status_of(app: &TestApp, cookie: &str, method: reqwest::Method, path: &str) -> u16 {
    app.req(method, path, cookie)
        .send()
        .await
        .expect("request")
        .status()
        .as_u16()
}

/// Alice's dentist appointment, in her personal calendar, on 20 October 2026.
async fn appointment(app: &TestApp, alice: &str) -> (Value, Value) {
    let calendar = personal(app, alice).await;
    let created = create_event(
        app,
        alice,
        &calendar["id"],
        json!({ "title": "Dentiste Kervella", "all_day": false, "location": "Cabinet Quimperlé",
                "description": "Couronne", "start": "2026-10-20T08:00:00Z",
                "end": "2026-10-20T09:00:00Z", "tzid": "Europe/Paris" }),
    )
    .await;
    assert_eq!(created.status(), 201);
    (calendar, created.json().await.expect("json"))
}

/// A one-hour event in full, as the form sends it.
fn whole(title: &str, start: &str) -> Value {
    let at = OffsetDateTime::parse(start, &time::format_description::well_known::Rfc3339)
        .expect("start");
    json!({ "title": title, "all_day": false, "start": start,
            "end": rfc(at + time::Duration::hours(1)), "tzid": "Europe/Paris" })
}

fn alices<'a>(found: &'a [Value], calendar: &Value) -> Vec<&'a Value> {
    found
        .iter()
        .filter(|o| o["calendar_id"] == calendar["id"])
        .collect()
}

async fn search_for(app: &TestApp, cookie: &str, q: &str) -> Vec<Value> {
    app.req(reqwest::Method::GET, "/api/v1/calendar/search", cookie)
        .query(&[("q", q)])
        .send()
        .await
        .expect("search")
        .json()
        .await
        .expect("json")
}

#[tokio::test]
async fn only_the_owner_shares_with_someone_of_a_common_space() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let dave = make_user(&app.db, "dave").await;
    let calendar = personal(&app, &alice).await;

    assert_eq!(share(&app, &alice, &calendar, fx.bob, "read").await, 204);
    // Someone with no space in common, oneself, an unknown level: refused.
    assert_eq!(share(&app, &alice, &calendar, dave, "read").await, 422);
    assert_eq!(share(&app, &alice, &calendar, fx.alice, "read").await, 422);
    assert_eq!(share(&app, &alice, &calendar, fx.carol, "owner").await, 422);
    // Bob sees it but does not own it; a space calendar is shared by its space already.
    assert_eq!(share(&app, &bob, &calendar, fx.carol, "read").await, 404);
    let general = space_default(&app, &alice, fx.space_id).await;
    assert_eq!(share(&app, &alice, &general, fx.carol, "read").await, 422);

    let listed: Vec<Value> = app
        .req(
            reqwest::Method::GET,
            &format!(
                "/api/v1/calendars/{}/shares",
                calendar["id"].as_str().unwrap()
            ),
            &alice,
        )
        .send()
        .await
        .expect("shares")
        .json()
        .await
        .expect("json");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["user_id"], json!(fx.bob));
    assert_eq!(listed[0]["level"], "read");
    assert_eq!(
        status_of(
            &app,
            &bob,
            reqwest::Method::GET,
            &format!(
                "/api/v1/calendars/{}/shares",
                calendar["id"].as_str().unwrap()
            )
        )
        .await,
        404
    );
}

#[tokio::test]
async fn each_level_shows_what_it_says_and_nothing_more() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let (calendar, event) = appointment(&app, &alice).await;
    let event_path = format!("/api/v1/events/{}", event["event_id"].as_str().unwrap());
    let (from, to) = ("2026-10-19T00:00:00Z", "2026-10-26T00:00:00Z");

    // Nothing shared: nothing seen.
    assert!(alices(&occurrences(&app, &bob, from, to).await, &calendar).is_empty());

    // Free/busy: a block, without a word of what it is.
    assert_eq!(
        share(&app, &alice, &calendar, fx.bob, "freebusy").await,
        204
    );
    let listed = calendars_of(&app, &bob).await;
    let shared = listed
        .iter()
        .find(|c| c["id"] == calendar["id"])
        .expect("listed");
    assert_eq!(shared["share_level"], "freebusy");
    assert_eq!(shared["owner_name"], "alice");
    assert_eq!(shared["can_write_events"], false);
    assert_eq!(shared["can_manage"], false);
    let found = occurrences(&app, &bob, from, to).await;
    let blocks = alices(&found, &calendar);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["busy"], true);
    assert_eq!(blocks[0]["title"], "");
    assert!(blocks[0]["location"].is_null() && blocks[0]["description"].is_null());
    let text = serde_json::to_string(&found).unwrap();
    assert!(
        !text.contains("Kervella") && !text.contains("Quimperlé") && !text.contains("Couronne")
    );
    assert_eq!(
        status_of(&app, &bob, reqwest::Method::GET, &event_path).await,
        404
    );
    assert!(search_for(&app, &bob, "Kervella").await.is_empty());

    // Details: read as an invitee reads, not written.
    assert_eq!(share(&app, &alice, &calendar, fx.bob, "read").await, 204);
    let found = occurrences(&app, &bob, from, to).await;
    assert_eq!(alices(&found, &calendar)[0]["title"], "Dentiste Kervella");
    assert_eq!(alices(&found, &calendar)[0]["busy"], false);
    assert_eq!(
        status_of(&app, &bob, reqwest::Method::GET, &event_path).await,
        200
    );
    assert_eq!(search_for(&app, &bob, "Kervella").await.len(), 1);
    let refused = edit(
        &app,
        &bob,
        &event["event_id"],
        "scope=all",
        whole("Autre", "2026-10-20T08:00:00Z"),
    )
    .await;
    assert!(
        matches!(refused.status().as_u16(), 403 | 404),
        "{}",
        refused.status()
    );

    // Changing events: create, change, delete; never the calendar itself.
    assert_eq!(share(&app, &alice, &calendar, fx.bob, "write").await, 204);
    let created = create_event(
        &app,
        &bob,
        &calendar["id"],
        json!({ "title": "Covoiturage", "all_day": false, "start": "2026-10-21T16:00:00Z",
                "end": "2026-10-21T17:00:00Z", "tzid": "Europe/Paris" }),
    )
    .await;
    assert_eq!(created.status(), 201);
    let made: Value = created.json().await.expect("json");
    let changed = edit(
        &app,
        &bob,
        &made["event_id"],
        "scope=all",
        whole("Covoiturage Brest", "2026-10-21T16:00:00Z"),
    )
    .await;
    assert_eq!(changed.status(), 200);
    assert_eq!(
        remove(&app, &bob, &made["event_id"], "scope=all").await,
        204
    );
    let renamed = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/calendars/{}", calendar["id"].as_str().unwrap()),
            &bob,
        )
        .json(&json!({ "name": "Pris" }))
        .send()
        .await
        .expect("rename");
    assert!(
        matches!(renamed.status().as_u16(), 403 | 404),
        "{}",
        renamed.status()
    );
}

#[tokio::test]
async fn a_share_ends_when_taken_back_or_when_no_space_is_left_in_common() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let carol = app.cookie_for(fx.carol).await;
    let (calendar, event) = appointment(&app, &alice).await;
    let event_path = format!("/api/v1/events/{}", event["event_id"].as_str().unwrap());
    let sees = |list: Vec<Value>| list.iter().any(|c| c["id"] == calendar["id"]);

    assert_eq!(share(&app, &alice, &calendar, fx.bob, "read").await, 204);
    assert_eq!(share(&app, &alice, &calendar, fx.carol, "read").await, 204);
    assert!(sees(calendars_of(&app, &bob).await));

    assert_eq!(unshare(&app, &alice, &calendar, fx.bob).await, 204);
    assert!(!sees(calendars_of(&app, &bob).await));
    assert_eq!(
        status_of(&app, &bob, reqwest::Method::GET, &event_path).await,
        404
    );

    // Carol leaves the only space she had with Alice: the share holds nothing any more.
    space_members::Entity::delete_by_id((fx.space_id, fx.carol))
        .exec(&app.db)
        .await
        .expect("leave");
    assert!(!sees(calendars_of(&app, &carol).await));
    assert_eq!(
        status_of(&app, &carol, reqwest::Method::GET, &event_path).await,
        404
    );
}

#[tokio::test]
async fn opening_a_share_tells_the_person_once() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let calendar = personal(&app, &alice).await;
    assert_eq!(share(&app, &alice, &calendar, fx.bob, "read").await, 204);
    assert_eq!(share(&app, &alice, &calendar, fx.bob, "write").await, 204);

    let inbox: Value = app
        .req(reqwest::Method::GET, "/api/v1/notifications", &bob)
        .send()
        .await
        .expect("inbox")
        .json()
        .await
        .expect("json");
    let shared: Vec<&Value> = inbox["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["kind"] == "calendar_shared")
        .collect();
    assert_eq!(shared.len(), 1);
    assert_eq!(shared[0]["actor_name"], "alice");
    assert_eq!(shared[0]["calendar_name"], calendar["name"]);
}

#[tokio::test]
async fn the_feed_of_all_calendars_carries_busy_blocks_only() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let (calendar, _) = appointment(&app, &alice).await;
    assert_eq!(
        share(&app, &alice, &calendar, fx.bob, "freebusy").await,
        204
    );

    let (_, path) = subscribe(&app, &bob, Value::Null).await;
    let (status, text) = fetch_feed(&app, &path).await;
    assert_eq!(status, 200);
    assert!(text.contains("DTSTART"), "{text}");
    assert!(
        !text.contains("Kervella") && !text.contains("Quimperlé") && !text.contains("Couronne"),
        "{text}"
    );
    // A personal address for the calendar itself is not open at this level.
    let refused = app
        .req(reqwest::Method::POST, "/api/v1/calendar/feeds", &bob)
        .json(&json!({ "calendar_id": calendar["id"] }))
        .send()
        .await
        .expect("feed");
    assert_eq!(refused.status(), 404);
}

#[tokio::test]
async fn an_invitation_through_a_busy_only_share_still_reads_in_full() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let calendar = personal(&app, &alice).await;
    let created = create_event(
        &app,
        &alice,
        &calendar["id"],
        json!({ "title": "Déjeuner Locronan", "all_day": false, "start": "2026-10-22T10:00:00Z",
                "end": "2026-10-22T11:00:00Z", "tzid": "Europe/Paris",
                "attendees": [{ "user_id": fx.bob }] }),
    )
    .await;
    assert_eq!(created.status(), 201);
    assert_eq!(
        share(&app, &alice, &calendar, fx.bob, "freebusy").await,
        204
    );

    let found = occurrences(&app, &bob, "2026-10-19T00:00:00Z", "2026-10-26T00:00:00Z").await;
    let lunch = alices(&found, &calendar);
    assert_eq!(lunch.len(), 1);
    assert_eq!(lunch[0]["title"], "Déjeuner Locronan");
    assert_eq!(lunch[0]["busy"], false);
    assert_eq!(lunch[0]["invited"], true);
    assert_eq!(search_for(&app, &bob, "Locronan").await.len(), 1);
}
