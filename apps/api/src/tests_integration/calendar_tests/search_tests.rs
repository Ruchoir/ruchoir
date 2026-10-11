//! Searching events: everything the person sees, past and future, a series once.

use super::*;

async fn search(app: &TestApp, cookie: &str, q: &str) -> Vec<Value> {
    let response = app
        .req(reqwest::Method::GET, "/api/v1/calendar/search", cookie)
        .query(&[("q", q)])
        .send()
        .await
        .expect("search");
    assert_eq!(response.status(), 200);
    response.json().await.expect("json")
}

fn titles(found: &[Value]) -> Vec<&str> {
    found.iter().map(|o| o["title"].as_str().unwrap()).collect()
}

/// A weekly Monday 9:00 Paris series of `count` dates from 2020-01-06, long over.
fn past_series(title: &str, count: u32) -> Value {
    json!({
        "title": title,
        "all_day": false,
        "start": "2020-01-06T08:00:00Z",
        "end": "2020-01-06T08:45:00Z",
        "tzid": "Europe/Paris",
        "rrule": format!("FREQ=WEEKLY;BYDAY=MO;COUNT={count}"),
    })
}

#[tokio::test]
async fn search_reads_title_place_notes_and_guests_within_what_one_sees() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let created = create_event(
        &app,
        &alice,
        &general["id"],
        json!({
            "title": "Atelier céramique", "all_day": false,
            "start": "2026-10-20T08:00:00Z", "end": "2026-10-20T09:00:00Z", "tzid": "Europe/Paris",
            "location": "Salle Quiberon", "description": "Apporter l'argile rouge",
            "attendees": [{ "email": "zoe.kerbrat@outside.test", "name": "Zoé Kerbrat" }],
        }),
    )
    .await;
    assert_eq!(created.status(), 201);

    // Someone in no common space, with a look-alike of their own.
    let dave = make_user(&app.db, "dave").await;
    let dave_cookie = app.cookie_for(dave).await;
    let personal = calendars_of(&app, &dave_cookie).await;
    let created = create_event(
        &app,
        &dave_cookie,
        &personal[0]["id"],
        json!({ "title": "Atelier céramique de Dave", "all_day": false,
                "start": "2026-10-21T08:00:00Z", "end": "2026-10-21T09:00:00Z", "tzid": "Europe/Paris" }),
    )
    .await;
    assert_eq!(created.status(), 201);

    // Without accents or case, by the place, the notes, a guest's name or address.
    for q in [
        "CERAMIQUE",
        "quiberon",
        "argile rouge",
        "zoe kerbrat",
        "zoe.kerbrat@outside",
    ] {
        assert_eq!(
            titles(&search(&app, &alice, q).await),
            vec!["Atelier céramique"],
            "{q}"
        );
    }
    // A member of the space finds it too; the stranger finds only theirs.
    assert_eq!(
        titles(&search(&app, &bob, "céramique").await),
        vec!["Atelier céramique"]
    );
    assert_eq!(
        titles(&search(&app, &dave_cookie, "céramique").await),
        vec!["Atelier céramique de Dave"]
    );
    // What is typed is looked for as such: `%` and `_` match only themselves.
    assert!(search(&app, &alice, "%").await.is_empty());
    assert!(search(&app, &alice, "_").await.is_empty());
    assert!(search(&app, &alice, "  ").await.is_empty());
}

#[tokio::test]
async fn a_series_comes_once_on_its_next_date_or_its_last() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let mut ongoing = weekly_meeting("Point Morbihan");
    ongoing["start"] = json!("2025-01-06T08:00:00Z");
    ongoing["end"] = json!("2025-01-06T08:45:00Z");
    assert_eq!(
        create_event(&app, &alice, &general["id"], ongoing)
            .await
            .status(),
        201
    );
    assert_eq!(
        create_event(
            &app,
            &alice,
            &general["id"],
            past_series("Point Finistère", 3)
        )
        .await
        .status(),
        201
    );

    let found = search(&app, &alice, "Point Morbihan").await;
    assert_eq!(found.len(), 1);
    let next = OffsetDateTime::parse(
        found[0]["start"].as_str().unwrap(),
        &time::format_description::well_known::Rfc3339,
    )
    .expect("start");
    let now = OffsetDateTime::now_utc();
    assert!(next >= now - time::Duration::hours(1) && next < now + time::Duration::days(7));

    let found = search(&app, &alice, "Finistère").await;
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["start"], "2020-01-20T08:00:00Z");
    assert_eq!(found[0]["recurrence_id"], "2020-01-20T08:00:00Z");
}

#[tokio::test]
async fn a_series_is_found_by_one_date_changed_alone() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let event: Value = create_event(&app, &alice, &general["id"], past_series("Point hebdo", 4))
        .await
        .json()
        .await
        .expect("json");
    let mut special = past_series("Point hebdo spécial trésorerie", 4);
    special["start"] = json!("2020-01-13T13:00:00Z");
    special["end"] = json!("2020-01-13T13:45:00Z");
    special.as_object_mut().unwrap().remove("rrule");
    let edited = edit(
        &app,
        &alice,
        &event["event_id"],
        "scope=this&recurrence_id=2020-01-13T08:00:00Z",
        special,
    )
    .await;
    assert_eq!(edited.status(), 200);

    let found = search(&app, &alice, "trésorerie").await;
    assert_eq!(titles(&found), vec!["Point hebdo spécial trésorerie"]);
    assert_eq!(found[0]["start"], "2020-01-13T13:00:00Z");
    assert_eq!(found[0]["recurrence_id"], "2020-01-13T08:00:00Z");
    // The series itself still comes once, on its last date.
    let found = search(&app, &alice, "Point hebdo").await;
    assert_eq!(found.len(), 1);
}
