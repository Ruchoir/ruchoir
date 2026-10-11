//! The defects the first calendar lot left noted: each test is one of them, fixed.

use super::*;
use crate::entities::calendar_events;

#[tokio::test]
async fn a_split_does_not_remind_a_date_twice() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let personal = calendars_of(&app, &alice)
        .await
        .into_iter()
        .find(|c| c["space_id"].is_null())
        .expect("personal");
    let now = sweep_moment(27);
    // Since yesterday, every day, today's in ten minutes.
    let start = now + time::Duration::minutes(10);
    let yesterday = start - time::Duration::days(1);
    let created = create_event(
        &app,
        &alice,
        &personal["id"],
        json!({ "title": "Point", "all_day": false, "start": rfc(yesterday),
                "end": rfc(yesterday + time::Duration::minutes(30)), "tzid": "Europe/Paris",
                "rrule": "FREQ=DAILY;COUNT=5" }),
    )
    .await;
    assert_eq!(created.status(), 201);
    let series: Value = created.json().await.expect("json");
    let first = crate::calendar::reminders::sweep(&app.state, now)
        .await
        .expect("sweep");
    assert_eq!(reminded(&first, &series), vec![fx.alice]);

    // Renamed from today on: a new series, the same date at the same time.
    let renamed = edit(
        &app,
        &alice,
        &series["event_id"],
        &format!("scope=following&recurrence_id={}", rfc(start)),
        json!({ "title": "Point renommé", "all_day": false, "start": rfc(start),
                "end": rfc(start + time::Duration::minutes(30)), "tzid": "Europe/Paris",
                "rrule": "FREQ=DAILY;COUNT=5" }),
    )
    .await;
    assert_eq!(renamed.status(), 200);
    let renamed: Value = renamed.json().await.expect("json");
    assert_ne!(renamed["event_id"], series["event_id"]);
    let again = crate::calendar::reminders::sweep(&app.state, now + time::Duration::minutes(1))
        .await
        .expect("sweep");
    assert!(
        reminded(&again, &renamed).is_empty(),
        "already reminded of that date"
    );
}

#[tokio::test]
async fn a_rule_that_cannot_be_read_does_not_stop_the_others_reminders() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let personal = calendars_of(&app, &alice)
        .await
        .into_iter()
        .find(|c| c["space_id"].is_null())
        .expect("personal");
    let now = sweep_moment(28);
    let good = event_in(&app, &alice, &personal["id"], "Lisible", now, 10).await;
    let broken = event_in(&app, &alice, &personal["id"], "Illisible", now, 10).await;
    // A rule the engine refuses, as an old import might have stored.
    let id: Uuid = broken["event_id"].as_str().unwrap().parse().unwrap();
    let mut row = calendar_events::Entity::find_by_id(id)
        .one(&app.db)
        .await
        .expect("query")
        .expect("row")
        .into_active_model();
    row.rrule = Set(Some("FREQ=SOMETIMES".to_owned()));
    row.update(&app.db).await.expect("break it");

    let report = crate::calendar::reminders::sweep(&app.state, now)
        .await
        .expect("the sweep goes on");
    assert_eq!(reminded(&report, &good), vec![fx.alice]);
}

#[tokio::test]
async fn a_january_event_is_covered_by_the_zone_the_feed_describes() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let created = create_event(
        &app,
        &alice,
        &general["id"],
        json!({ "title": "Voeux", "all_day": false, "start": "2027-01-12T10:00:00Z",
                "end": "2027-01-12T11:00:00Z", "tzid": "Europe/Paris" }),
    )
    .await;
    assert_eq!(created.status(), 201);
    let (_, path) = subscribe(&app, &alice, general["id"].clone()).await;
    let (_, text) = fetch_feed(&app, &path).await;
    // In force on 12 January: winter time, which started the October before.
    assert!(
        text.contains("BEGIN:STANDARD\r\nDTSTART:20261025T030000"),
        "{text}"
    );
}
