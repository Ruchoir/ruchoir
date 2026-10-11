//! The defects the first calendar lot left noted: each test is one of them, fixed.

use super::*;

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
    assert!(reminded(&again, &renamed).is_empty(), "already reminded of that date");
}
