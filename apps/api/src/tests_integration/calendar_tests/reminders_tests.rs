//! Several reminders per event: each sent once at its own moment, five at most, each once.

use super::*;

async fn personal_of(app: &TestApp, cookie: &str) -> Value {
    calendars_of(app, cookie)
        .await
        .into_iter()
        .find(|c| c["space_id"].is_null())
        .expect("personal")
}

async fn set_mine(app: &TestApp, cookie: &str, event: &Value, body: Value) -> reqwest::StatusCode {
    app.req(
        reqwest::Method::PUT,
        &format!("/api/v1/events/{}/me", event["event_id"].as_str().unwrap()),
        cookie,
    )
    .json(&body)
    .send()
    .await
    .expect("me")
    .status()
}

#[tokio::test]
async fn two_reminders_of_one_date_are_two_notices_sent_once_each() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let personal = personal_of(&app, &alice).await;
    let now = sweep_moment(29);
    let event = event_in(&app, &alice, &personal["id"], "Dentiste", now, 10).await;
    assert_eq!(
        set_mine(&app, &alice, &event, json!({ "reminders": [10, 15] })).await,
        204
    );

    let first = crate::calendar::reminders::sweep(&app.state, now)
        .await
        .expect("sweep");
    assert_eq!(reminded(&first, &event), vec![fx.alice, fx.alice]);
    let again = crate::calendar::reminders::sweep(&app.state, now + time::Duration::minutes(1))
        .await
        .expect("sweep");
    assert!(reminded(&again, &event).is_empty());
}

#[tokio::test]
async fn five_reminders_at_most_each_once() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let personal = personal_of(&app, &alice).await;
    let event = event_in(
        &app,
        &alice,
        &personal["id"],
        "Revue",
        sweep_moment(30),
        120,
    )
    .await;
    assert_eq!(
        set_mine(
            &app,
            &alice,
            &event,
            json!({ "reminders": [5, 10, 15, 30, 60] })
        )
        .await,
        204
    );
    assert_eq!(
        set_mine(
            &app,
            &alice,
            &event,
            json!({ "reminders": [5, 10, 15, 30, 60, 90] })
        )
        .await,
        422
    );
    assert_eq!(
        set_mine(&app, &alice, &event, json!({ "reminders": [10, 10] })).await,
        422
    );
    // A delay of one's own, up to four weeks.
    assert_eq!(
        set_mine(&app, &alice, &event, json!({ "reminders": [20, 2880] })).await,
        204
    );
    let read: Value = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/events/{}", event["event_id"].as_str().unwrap()),
            &alice,
        )
        .send()
        .await
        .expect("event")
        .json()
        .await
        .expect("json");
    assert_eq!(read["my_own_reminders"], json!([20, 2880]));
    assert_eq!(read["my_reminders"], json!([20, 2880]));
    // Back to the calendar's.
    assert_eq!(
        set_mine(&app, &alice, &event, json!({ "reminder_default": true })).await,
        204
    );
}

#[tokio::test]
async fn a_calendar_has_several_default_reminders() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let created = app
        .req(reqwest::Method::POST, "/api/v1/calendars", &alice)
        .json(&json!({ "name": "Rendez-vous", "color": "mint", "default_reminders": [60, 10] }))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);
    let calendar: Value = created.json().await.expect("json");
    assert_eq!(calendar["default_reminders"], json!([60, 10]));
    let now = sweep_moment(31);
    let event = event_in(&app, &alice, &calendar["id"], "Coiffeur", now, 10).await;
    let report = crate::calendar::reminders::sweep(&app.state, now)
        .await
        .expect("sweep");
    // Ten minutes before is due; an hour before was fifty minutes ago, too late to send.
    assert_eq!(reminded(&report, &event), vec![fx.alice]);
}

#[tokio::test]
async fn a_reminder_sent_before_delays_existed_is_not_sent_again() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let personal = personal_of(&app, &alice).await;
    let now = sweep_moment(26);
    let event = event_in(&app, &alice, &personal["id"], "Ancien", now, 10).await;
    let id: Uuid = event["event_id"].as_str().unwrap().parse().unwrap();
    // A row as the previous version wrote it: no delay.
    app.db
        .execute_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            "INSERT INTO calendar_reminder_deliveries (user_id, event_id, occurrence_start, sent_at) \
             VALUES ($1, $2, $3, $4)",
            [
                fx.alice.into(),
                id.into(),
                (now + time::Duration::minutes(10)).into(),
                now.into(),
            ],
        ))
        .await
        .expect("legacy row");
    let report = crate::calendar::reminders::sweep(&app.state, now)
        .await
        .expect("sweep");
    assert!(reminded(&report, &event).is_empty());
}

#[tokio::test]
async fn a_subscription_carries_its_readers_reminders() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let personal = personal_of(&app, &alice).await;
    let event = event_in(
        &app,
        &alice,
        &personal["id"],
        "Banque",
        sweep_moment(25),
        600,
    )
    .await;
    assert_eq!(
        set_mine(&app, &alice, &event, json!({ "reminders": [10, 1440] })).await,
        204
    );
    let (_, path) = subscribe(&app, &alice, personal["id"].clone()).await;
    let (_, text) = fetch_feed(&app, &path).await;
    let ours = text
        .split("BEGIN:VEVENT")
        .find(|block| block.contains("SUMMARY:Banque"))
        .expect("the event");
    assert_eq!(ours.matches("BEGIN:VALARM").count(), 2, "{ours}");
    // Written in seconds, as RFC 5545 allows.
    assert!(ours.contains("TRIGGER:-PT600S"), "{ours}");
    assert!(ours.contains("TRIGGER:-PT86400S"), "{ours}");
}
