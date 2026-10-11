//! Importing calendars: each one a personal calendar of its owner, each event read from its
//! iCalendar text, once, silently, and the same archive run twice writing nothing twice.

use super::*;
use crate::entities::{
    calendar_event_attendees, calendar_event_exceptions, calendar_event_reminders, calendar_events,
    calendars,
};
use crate::importer::calendars::{KIND_CALENDAR, KIND_EVENT};

fn vcalendar(body: &str) -> String {
    format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Sabre//Sabre VObject//EN\r\n{body}END:VCALENDAR\r\n")
}

struct Fixture {
    dir: std::path::PathBuf,
    alice: String,
    bob: String,
    alice_email: String,
    bob_email: String,
}

/// An archive of two people, a calendar each, and the shapes a Nextcloud calendar holds.
fn calendar_archive() -> Fixture {
    let (alice, bob) = (unique_ref("alice"), unique_ref("bob"));
    let (alice_email, bob_email) = (
        format!("{alice}@example.test"),
        format!("{bob}@example.test"),
    );
    let space = unique_ref("nextcloud");
    let dir = write_archive(
        &[
            json!({"id": space, "name": format!("Nextcloud {}", Uuid::new_v4().simple()), "visibility": "private"}),
        ],
        &[
            json!({"id": alice, "email": alice_email, "display_name": "Alice Martin", "active": true}),
            json!({"id": bob, "email": bob_email, "display_name": "Bob Leroy", "active": true}),
        ],
        &[],
        &[],
    );
    let alice_cal = format!("{alice}/personal");
    let bob_cal = format!("{bob}/personal");
    let calendars = [
        json!({"id": alice_cal, "owner": alice, "name": "Personnel", "description": "", "color": "#0082c9"}),
        json!({"id": bob_cal, "owner": bob, "name": "Chantiers", "description": "Visites", "color": "#ffd700"}),
    ];
    let meeting = |calendar: &str, id: &str| {
        json!({"id": id, "calendar": calendar, "ics": vcalendar(&format!(concat!(
            "BEGIN:VEVENT\r\nUID:meeting-1\r\n",
            "DTSTART;TZID=Europe/Paris:20261013T100000\r\nDTEND;TZID=Europe/Paris:20261013T110000\r\n",
            "SUMMARY:Revue client\r\nLOCATION:Salle Ouest\r\n",
            "ORGANIZER;CN=Alice Martin:mailto:{a}\r\n",
            "ATTENDEE;CN=Bob Leroy;PARTSTAT=ACCEPTED:mailto:{b}\r\n",
            "ATTENDEE;CN=Claire Dupont;PARTSTAT=TENTATIVE:mailto:claire@client.test\r\n",
            "END:VEVENT\r\n"), a = alice_email, b = bob_email))})
    };
    let events = [
        json!({"id": format!("{alice_cal}/series.ics"), "calendar": alice_cal, "ics": vcalendar(concat!(
            "BEGIN:VEVENT\r\nUID:series-1\r\n",
            "DTSTART;TZID=Europe/Paris:20261005T090000\r\nDTEND;TZID=Europe/Paris:20261005T094500\r\n",
            "SUMMARY:Point \u{e9}quipe\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\n",
            "EXDATE;TZID=Europe/Paris:20261012T090000\r\nCATEGORIES:R\u{e9}union\r\n",
            "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT20M\r\nEND:VALARM\r\n",
            "END:VEVENT\r\n",
            "BEGIN:VEVENT\r\nUID:series-1\r\nRECURRENCE-ID;TZID=Europe/Paris:20261019T090000\r\n",
            "DTSTART;TZID=Europe/Paris:20261019T110000\r\nDTEND;TZID=Europe/Paris:20261019T114500\r\n",
            "SUMMARY:Point \u{e9}quipe\r\nEND:VEVENT\r\n"))}),
        meeting(&alice_cal, &format!("{alice_cal}/meeting.ics")),
        // Nextcloud files the invitation in Bob's calendar too: it must not come over twice.
        meeting(&bob_cal, &format!("{bob_cal}/meeting.ics")),
        json!({"id": format!("{bob_cal}/outside.ics"), "calendar": bob_cal, "ics": vcalendar(&format!(concat!(
            "BEGIN:VEVENT\r\nUID:outside-1\r\nDTSTART:20261015T130000Z\r\nDTEND:20261015T140000Z\r\n",
            "SUMMARY:Salon Batimat\r\nORGANIZER:mailto:orga@salon.test\r\n",
            "ATTENDEE;PARTSTAT=ACCEPTED:mailto:{b}\r\nEND:VEVENT\r\n"), b = bob_email))}),
        json!({"id": format!("{alice_cal}/day.ics"), "calendar": alice_cal, "ics": vcalendar(concat!(
            "BEGIN:VEVENT\r\nUID:day-1\r\nDTSTART;VALUE=DATE:20261016\r\nDTEND;VALUE=DATE:20261017\r\n",
            "SUMMARY:S\u{e9}minaire\r\nEND:VEVENT\r\n"))}),
        json!({"id": format!("{alice_cal}/cancelled.ics"), "calendar": alice_cal, "ics": vcalendar(concat!(
            "BEGIN:VEVENT\r\nUID:gone-1\r\nDTSTART:20261020T080000Z\r\nSTATUS:CANCELLED\r\n",
            "SUMMARY:Annul\u{e9}\r\nEND:VEVENT\r\n"))}),
        json!({"id": format!("{alice_cal}/odd.ics"), "calendar": alice_cal, "ics": vcalendar(concat!(
            "BEGIN:VEVENT\r\nUID:odd-1\r\nDTSTART:20261020T080000Z\r\nRRULE:FREQ=SOMETIMES\r\n",
            "SUMMARY:Bizarre\r\nEND:VEVENT\r\n"))}),
    ];
    let write = |name: &str, rows: &[Value]| {
        let body: String = rows.iter().map(|row| format!("{row}\n")).collect();
        std::fs::write(dir.join(name), body).expect("write");
    };
    write("calendars.jsonl", &calendars);
    write("events.jsonl", &events);
    Fixture {
        dir,
        alice,
        bob,
        alice_email,
        bob_email,
    }
}

/// An administrator of the instance: their import creates the archive's people as accounts.
async fn promote(app: &TestApp, user: Uuid) {
    let mut admin: users::ActiveModel = users::Entity::find_by_id(user)
        .one(&app.db)
        .await
        .expect("query")
        .expect("user")
        .into();
    admin.is_instance_admin = Set(true);
    admin.update(&app.db).await.expect("promote");
}

async fn run_import(
    app: &TestApp,
    admin: Uuid,
    dir: &std::path::Path,
) -> crate::importer::job::Outcome {
    promote(app, admin).await;
    let job = run::start_job(&app.db, "mattermost", admin, None, "{}")
        .await
        .expect("job");
    crate::importer::job::execute_into(
        &app.db,
        Some(&MemorySink::default()),
        dir,
        None,
        admin,
        job,
        crate::importer::job::RunSettings {
            thumbnail_max_px: THUMBNAIL_MAX_PX,
            secret_key: [7; 32],
        },
    )
    .await
    .expect("import")
}

async fn account(app: &TestApp, email: &str) -> Uuid {
    users::Entity::find()
        .filter(users::Column::Email.eq(email))
        .one(&app.db)
        .await
        .expect("query")
        .expect("account")
        .id
}

async fn event_by_uid(app: &TestApp, calendar: Uuid, uid: &str) -> Option<calendar_events::Model> {
    calendar_events::Entity::find()
        .filter(calendar_events::Column::CalendarId.eq(calendar))
        .filter(calendar_events::Column::Uid.eq(uid))
        .one(&app.db)
        .await
        .expect("query")
}

async fn calendar_of(app: &TestApp, owner: Uuid, name: &str) -> calendars::Model {
    calendars::Entity::find()
        .filter(calendars::Column::OwnerUserId.eq(owner))
        .filter(calendars::Column::Name.eq(name))
        .one(&app.db)
        .await
        .expect("query")
        .expect("calendar")
}

#[tokio::test]
async fn nextcloud_calendars_land_with_their_owners() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let archive = calendar_archive();
    let outcome = run_import(&app, fx.alice, &archive.dir).await;
    let written = outcome.written.calendars;
    assert_eq!(written.calendars_created, 2);
    assert_eq!(written.events_created, 4, "{written:?}");
    assert_eq!(written.copies_passed_over, 1);
    assert_eq!(written.events_left_behind, 2);

    let alice = account(&app, &archive.alice_email).await;
    let bob = account(&app, &archive.bob_email).await;
    let personal = calendar_of(&app, alice, "Personnel").await;
    assert_eq!((personal.color.as_str(), personal.space_id), ("sky", None));
    let sites = calendar_of(&app, bob, "Chantiers").await;
    assert_eq!(sites.color, "sun");
    assert_eq!(sites.description.as_deref(), Some("Visites"));

    // The series, its cancelled date and its moved one, its alarm, what Ruchoir keeps aside.
    let series = event_by_uid(&app, personal.id, "series-1")
        .await
        .expect("series");
    assert_eq!(series.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=MO"));
    assert_eq!(series.tzid.as_deref(), Some("Europe/Paris"));
    assert_eq!(series.created_by, Some(alice));
    assert_eq!(series.ical_extra, json!(["CATEGORIES:R\u{e9}union"]));
    let exceptions = calendar_event_exceptions::Entity::find()
        .filter(calendar_event_exceptions::Column::EventId.eq(series.id))
        .all(&app.db)
        .await
        .expect("query");
    let cancelled = exceptions
        .iter()
        .find(|e| e.recurrence_id == "2026-10-12T07:00:00Z")
        .expect("cancelled");
    assert!(cancelled.cancelled);
    let moved = exceptions
        .iter()
        .find(|e| e.recurrence_id == "2026-10-19T07:00:00Z")
        .expect("moved");
    assert!(!moved.cancelled);
    assert_eq!(moved.title, None, "the same title is the series' own");
    assert_eq!(moved.start_at.map(|t| t.hour()), Some(9));
    let reminder = calendar_event_reminders::Entity::find_by_id((alice, series.id))
        .one(&app.db)
        .await
        .expect("query")
        .expect("reminder");
    assert_eq!(reminder.minutes, Some(30));

    // The meeting, once, in its organiser's calendar, with its people and their answers.
    let meeting = event_by_uid(&app, personal.id, "meeting-1")
        .await
        .expect("meeting");
    assert!(event_by_uid(&app, sites.id, "meeting-1").await.is_none());
    let people = calendar_event_attendees::Entity::find()
        .filter(calendar_event_attendees::Column::EventId.eq(meeting.id))
        .all(&app.db)
        .await
        .expect("query");
    let bob_row = people.iter().find(|p| p.user_id == Some(bob)).expect("bob");
    assert_eq!(bob_row.status, "accepted");
    let claire = people
        .iter()
        .find(|p| p.email.as_deref() == Some("claire@client.test"))
        .expect("claire");
    assert_eq!(
        (claire.status.as_str(), claire.name.as_deref()),
        ("tentative", Some("Claire Dupont"))
    );
    assert!(claire.token_digest.is_some());

    // An invitation from outside is Bob's own event; a whole day stays a day.
    let outside = event_by_uid(&app, sites.id, "outside-1")
        .await
        .expect("outside");
    assert_eq!(outside.created_by, Some(bob));
    let day = event_by_uid(&app, personal.id, "day-1").await.expect("day");
    assert!(day.all_day);
    assert!(event_by_uid(&app, personal.id, "gone-1").await.is_none());
    assert!(event_by_uid(&app, personal.id, "odd-1").await.is_none());

    // Nobody was told.
    let told = notifications::Entity::find()
        .filter(notifications::Column::UserId.eq(bob))
        .count(&app.db)
        .await
        .expect("count");
    assert_eq!(told, 0);
    let _ = (&archive.alice, &archive.bob);
}

#[tokio::test]
async fn the_same_archive_twice_writes_nothing_twice() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let archive = calendar_archive();
    let first = run_import(&app, fx.alice, &archive.dir).await;
    assert_eq!(first.written.calendars.events_created, 4);
    let second = run_import(&app, fx.alice, &archive.dir).await;
    assert_eq!(second.written.calendars.calendars_created, 0);
    assert_eq!(second.written.calendars.events_created, 0);
    assert_eq!(second.written.calendars.events_seen, 7);
    let alice = account(&app, &archive.alice_email).await;
    let personal = calendar_of(&app, alice, "Personnel").await;
    let count = calendar_events::Entity::find()
        .filter(calendar_events::Column::CalendarId.eq(personal.id))
        .count(&app.db)
        .await
        .expect("count");
    assert_eq!(count, 3);
    let mapper = Mapper::new(Uuid::new_v4(), "mattermost");
    mapper.preload(&app.db).await.expect("preload");
    assert!(mapper
        .resolve(
            &app.db,
            KIND_CALENDAR,
            &format!("{}/personal", archive.alice),
            None
        )
        .await
        .expect("r")
        .is_some());
    assert!(mapper
        .resolve(
            &app.db,
            KIND_EVENT,
            &format!("{}/personal/series.ics", archive.alice),
            None
        )
        .await
        .expect("r")
        .is_some());
}

#[tokio::test]
async fn a_job_counts_its_calendars_and_events() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let archive = calendar_archive();
    promote(&app, fx.alice).await;
    let job = run::start_job(&app.db, "mattermost", fx.alice, None, "{}")
        .await
        .expect("job");
    crate::importer::job::execute_into(
        &app.db,
        Some(&MemorySink::default()),
        &archive.dir,
        None,
        fx.alice,
        job,
        crate::importer::job::RunSettings {
            thumbnail_max_px: THUMBNAIL_MAX_PX,
            secret_key: [7; 32],
        },
    )
    .await
    .expect("import");
    let row = crate::entities::import_jobs::Entity::find_by_id(job)
        .one(&app.db)
        .await
        .expect("query")
        .expect("job");
    assert_eq!((row.calendars_done, row.calendars_total), (2, 2));
    assert_eq!((row.events_done, row.events_total), (7, 7));
    let _ = &archive.bob_email;
}

#[tokio::test]
async fn an_imported_reminder_is_the_owners_own_choice() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let archive = calendar_archive();
    run_import(&app, fx.alice, &archive.dir).await;
    let alice = account(&app, &archive.alice_email).await;
    let personal = calendar_of(&app, alice, "Personnel").await;
    let series = event_by_uid(&app, personal.id, "series-1")
        .await
        .expect("series");
    let meeting = event_by_uid(&app, personal.id, "meeting-1")
        .await
        .expect("meeting");
    let cookie = app.cookie_for(alice).await;
    let read = |id: Uuid| {
        let request = app.req(
            reqwest::Method::GET,
            &format!("/api/v1/events/{id}"),
            &cookie,
        );
        async move {
            request
                .send()
                .await
                .expect("event")
                .json::<Value>()
                .await
                .expect("json")
        }
    };
    // Set by the import: the event's own choice, not what the calendar would give.
    assert_eq!(read(series.id).await["my_own_reminder"], 30);
    // None set: the key is absent, and the event follows its calendar.
    assert!(read(meeting.id).await.get("my_own_reminder").is_none());
}
