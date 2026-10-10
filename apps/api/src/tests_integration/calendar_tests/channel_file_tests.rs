//! Lot C: an event linked to a channel (seen through it, announced with a card, listed as upcoming,
//! its members invited at once) and the Drive files an event carries.

use super::*;

async fn personal(app: &TestApp, cookie: &str) -> Value {
    calendars_of(app, cookie)
        .await
        .into_iter()
        .find(|c| c["space_id"].is_null() && c["is_default"] == true)
        .expect("a personal calendar")
}

fn linked(title: &str, channel: Option<Uuid>) -> Value {
    json!({
        "title": title,
        "all_day": false,
        "start": "2031-04-07T08:00:00Z",
        "end": "2031-04-07T09:00:00Z",
        "tzid": "Europe/Paris",
        "location": "Salle Ouest",
        "channel_id": channel,
    })
}

async fn get_json(app: &TestApp, cookie: &str, path: &str) -> (u16, Value) {
    let response = app
        .req(reqwest::Method::GET, path, cookie)
        .send()
        .await
        .expect("get");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// The calendar cards of a channel, oldest first, as (event, body, card title).
async fn cards(app: &TestApp, cookie: &str, channel: Uuid) -> Vec<(String, String, String)> {
    let (_, page) = get_json(
        app,
        cookie,
        &format!("/api/v1/conversations/{channel}/messages?limit=100"),
    )
    .await;
    let found: Vec<(String, String, String)> = page["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .filter(|m| {
            m["system_event"]
                .as_str()
                .is_some_and(|e| e.starts_with("calendar_"))
        })
        .map(|m| {
            (
                m["system_event"].as_str().unwrap().to_owned(),
                m["body"].as_str().unwrap_or_default().to_owned(),
                m["event"]["title"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    // The page comes oldest first.
    found
}

#[tokio::test]
async fn the_channels_one_may_link_are_those_one_reads() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let names = |list: &Value| -> Vec<String> {
        let mut names: Vec<String> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap().to_owned())
            .collect();
        names.sort();
        names
    };
    let path = format!(
        "/api/v1/calendars/{}/channels",
        general["id"].as_str().unwrap()
    );
    let (_, alices) = get_json(&app, &alice, &path).await;
    assert_eq!(names(&alices), vec!["general", "secret"]);
    let (_, bobs) = get_json(&app, &bob, &path).await;
    assert_eq!(
        names(&bobs),
        vec!["general"],
        "not a private channel bob is not in"
    );

    // Linking a channel one may not read is refused.
    let refused = create_event(
        &app,
        &bob,
        &general["id"],
        linked("Point", Some(fx.private_channel)),
    )
    .await;
    assert_eq!(refused.status(), 422);
}

#[tokio::test]
async fn a_linked_channel_shows_the_event_to_its_readers() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let dave = make_user(&app.db, "dave").await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let mine = personal(&app, &alice).await;
    let created: Value = create_event(
        &app,
        &alice,
        &mine["id"],
        linked("Atelier", Some(fx.public_channel)),
    )
    .await
    .json()
    .await
    .expect("json");
    assert_eq!(created["channel"]["name"], "general");
    let path = format!("/api/v1/events/{}", created["event_id"].as_str().unwrap());

    // Bob reads the channel: he sees the event, read only.
    let (status, seen) = get_json(&app, &bob, &path).await;
    assert_eq!(status, 200);
    assert_eq!(seen["can_edit"], false);
    assert_eq!(seen["channel"]["accessible"], true);
    // Someone outside the space does not.
    let (status, _) = get_json(&app, &app.cookie_for(dave).await, &path).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn a_private_channel_is_named_only_to_its_members() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let carol = app.cookie_for(fx.carol).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let created: Value = create_event(
        &app,
        &alice,
        &general["id"],
        linked("Comité", Some(fx.private_channel)),
    )
    .await
    .json()
    .await
    .expect("json");
    let (status, seen) = get_json(
        &app,
        &carol,
        &format!("/api/v1/events/{}", created["event_id"].as_str().unwrap()),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(seen["channel"]["accessible"], false);
    assert_eq!(seen["channel"]["name"], Value::Null);
}

#[tokio::test]
async fn a_card_follows_the_event_in_its_channel() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let mut body = linked("Revue", Some(fx.public_channel));
    body["attendees"] = json!([{ "user_id": fx.bob }]);
    let created: Value = create_event(&app, &alice, &general["id"], body)
        .await
        .json()
        .await
        .expect("json");
    let id = &created["event_id"];

    // Posted, and drawn as the event stands, with the reader's answer.
    let found = cards(&app, &bob, fx.public_channel).await;
    assert_eq!(
        found,
        vec![(
            "calendar_event_posted".to_owned(),
            "Revue".to_owned(),
            "Revue".to_owned()
        )]
    );
    let (_, page) = get_json(
        &app,
        &bob,
        &format!(
            "/api/v1/conversations/{}/messages?limit=100",
            fx.public_channel
        ),
    )
    .await;
    let card = page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["system_event"] == "calendar_event_posted")
        .expect("the card")
        .clone();
    assert_eq!(card["event"]["event_id"], *id);
    assert_eq!(card["event"]["my_status"], "needs_action");
    assert_eq!(card["event"]["location"], "Salle Ouest");
    assert_eq!(card["event"]["organizer"], "alice");
    assert_eq!(card["event"]["organizer_id"], fx.alice.to_string());

    // A new time is said; a new title alone is not, the card shows it anyway.
    let mut moved = linked("Revue client", Some(fx.public_channel));
    moved["start"] = json!("2031-04-07T09:00:00Z");
    moved["end"] = json!("2031-04-07T10:00:00Z");
    edit(&app, &alice, id, "", moved).await;
    let mut renamed = linked("Revue client", Some(fx.public_channel));
    renamed["start"] = json!("2031-04-07T09:00:00Z");
    renamed["end"] = json!("2031-04-07T10:00:00Z");
    edit(&app, &alice, id, "", renamed).await;
    let found = cards(&app, &bob, fx.public_channel).await;
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].2, "Revue client", "the card is drawn live");
    assert_eq!(found[1].0, "calendar_event_changed");

    // Deleted: the notice keeps its title, the event being gone.
    assert_eq!(remove(&app, &alice, id, "").await, 204);
    let found = cards(&app, &bob, fx.public_channel).await;
    assert_eq!(found.len(), 3);
    assert_eq!(found[2].0, "calendar_event_cancelled");
    assert_eq!(found[2].1, "Revue client");
}

#[tokio::test]
async fn a_channel_lists_its_upcoming_events() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    // Tomorrow, then every week: the channel looks sixty days ahead.
    let start = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap() + time::Duration::days(1);
    let rfc = |at: OffsetDateTime| {
        at.format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    };
    let mut weekly = linked("Point hebdo", Some(fx.public_channel));
    weekly["start"] = json!(rfc(start));
    weekly["end"] = json!(rfc(start + time::Duration::hours(1)));
    weekly["rrule"] = json!("FREQ=WEEKLY");
    create_event(&app, &alice, &general["id"], weekly).await;
    create_event(&app, &alice, &general["id"], linked("Ailleurs", None)).await;

    let (status, upcoming) = get_json(
        &app,
        &bob,
        &format!("/api/v1/channels/{}/events", fx.public_channel),
    )
    .await;
    assert_eq!(status, 200);
    let titles: Vec<&str> = upcoming
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, vec!["Point hebdo", "Point hebdo", "Point hebdo"]);
    // Someone who cannot read the channel learns nothing of it.
    let (status, _) = get_json(
        &app,
        &bob,
        &format!("/api/v1/channels/{}/events", fx.private_channel),
    )
    .await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn a_channel_offers_its_members_as_invitees() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let (_, found) = get_json(
        &app,
        &alice,
        &format!(
            "/api/v1/calendars/{}/invitees?channel={}",
            general["id"].as_str().unwrap(),
            fx.public_channel
        ),
    )
    .await;
    let names: Vec<&str> = found
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    // Alice and Bob are in #general; Carol is in the space but not the channel.
    assert_eq!(names, vec!["bob"]);
}

#[tokio::test]
async fn only_files_of_a_space_tree_one_reads_are_attached() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let plan = insert_file_row(&app.db, fx.space_id, fx.alice, "plan.pdf").await;
    let mut body = linked("Revue", None);
    body["files"] = json!([plan, plan]);
    let created = create_event(&app, &alice, &general["id"], body).await;
    assert_eq!(created.status(), 201);
    let created: Value = created.json().await.expect("json");
    assert_eq!(created["files"].as_array().unwrap().len(), 1, "no repeats");
    assert_eq!(created["files"][0]["name"], "plan.pdf");

    // An attachment of a private conversation keeps its own audience.
    let private = Uuid::new_v4();
    files::ActiveModel {
        id: Set(private),
        space_id: Set(fx.space_id),
        owner_id: Set(Some(fx.alice)),
        name: Set("confidentiel.pdf".to_owned()),
        kind: Set("file".to_owned()),
        conversation_id: Set(Some(fx.private_channel)),
        size_bytes: Set(1),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("file");
    let mut body = linked("Revue", None);
    body["files"] = json!([private]);
    assert_eq!(
        create_event(&app, &alice, &general["id"], body)
            .await
            .status(),
        422
    );

    // Nor a file one cannot read.
    let other_space = Uuid::new_v4();
    spaces::ActiveModel {
        id: Set(other_space),
        name: Set("Ailleurs".to_owned()),
        slug: Set(format!("ailleurs-{}", other_space.simple())),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("space");
    let elsewhere = insert_file_row(&app.db, other_space, fx.bob, "ailleurs.pdf").await;
    let mut body = linked("Revue", None);
    body["files"] = json!([elsewhere]);
    assert_eq!(
        create_event(&app, &alice, &general["id"], body)
            .await
            .status(),
        422
    );
}

#[tokio::test]
async fn an_event_gives_read_access_to_its_files_and_takes_it_back() {
    use crate::files::authz::{ensure_content_editable, ensure_readable};
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let dave = make_user(&app.db, "dave").await;
    let alice = app.cookie_for(fx.alice).await;
    // Dave shares another space with Alice, not this one.
    let other = Uuid::new_v4();
    spaces::ActiveModel {
        id: Set(other),
        name: Set("Commun".to_owned()),
        slug: Set(format!("commun-{}", other.simple())),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("space");
    for user in [fx.alice, dave] {
        space_members::ActiveModel {
            space_id: Set(other),
            user_id: Set(user),
            role: Set("member".to_owned()),
            ..Default::default()
        }
        .insert(&app.db)
        .await
        .expect("member");
    }
    let plan = insert_file_row(&app.db, fx.space_id, fx.alice, "plan.pdf").await;
    assert!(ensure_readable(&app.db, plan, dave).await.is_err());

    let mine = personal(&app, &alice).await;
    let mut body = linked("Revue", None);
    body["attendees"] = json!([{ "user_id": dave }]);
    body["files"] = json!([plan]);
    let created: Value = create_event(&app, &alice, &mine["id"], body)
        .await
        .json()
        .await
        .expect("json");
    let access = ensure_readable(&app.db, plan, dave)
        .await
        .expect("read through the event");
    assert!(access.through_event && !access.can_edit);
    assert!(ensure_content_editable(&app.db, plan, dave).await.is_err());

    let mut without = linked("Revue", None);
    without["files"] = json!([]);
    assert_eq!(
        edit(&app, &alice, &created["event_id"], "", without)
            .await
            .status(),
        200
    );
    assert!(ensure_readable(&app.db, plan, dave).await.is_err());
}

#[tokio::test]
async fn a_guest_by_address_sees_the_files_on_the_answer_page() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let plan = insert_file_row(&app.db, fx.space_id, fx.alice, "plan.pdf").await;
    let other = insert_file_row(&app.db, fx.space_id, fx.alice, "autre.pdf").await;
    let mut body = linked("Revue", None);
    body["attendees"] = json!([{ "email": "client@outside.test" }]);
    body["files"] = json!([plan]);
    let created: Value = create_event(&app, &alice, &general["id"], body)
        .await
        .json()
        .await
        .expect("json");
    let event_id: Uuid = created["event_id"].as_str().unwrap().parse().unwrap();
    let row = crate::entities::calendar_event_attendees::Entity::find()
        .filter(crate::entities::calendar_event_attendees::Column::EventId.eq(event_id))
        .one(&app.db)
        .await
        .expect("query")
        .expect("attendee");
    let token = crate::calendar::attendees::token_of(&app.state.secret_key, &row).expect("token");
    let page: Value = app
        .http
        .get(format!("{}/api/v1/public/invitation/{token}", app.base))
        .send()
        .await
        .expect("page")
        .json()
        .await
        .expect("json");
    assert_eq!(page["files"][0]["name"], "plan.pdf");
    // A file the event does not carry is not there to download.
    let refused = app
        .http
        .get(format!(
            "{}/api/v1/public/invitation/{token}/files/{other}",
            app.base
        ))
        .send()
        .await
        .expect("download");
    assert_eq!(refused.status(), 404);
}

#[tokio::test]
async fn files_dropped_for_an_event_go_to_the_agenda_folder() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let path = format!(
        "/api/v1/calendars/{}/attachment-folder",
        general["id"].as_str().unwrap()
    );
    let (status, first) = get_json(&app, &alice, &path).await;
    assert_eq!(status, 200);
    let (_, again) = get_json(&app, &alice, &path).await;
    assert_eq!(first["folder_id"], again["folder_id"]);
    assert_eq!(first["space_id"], fx.space_id.to_string());
    let folder: Uuid = first["folder_id"].as_str().unwrap().parse().unwrap();
    let row = files::Entity::find_by_id(folder)
        .one(&app.db)
        .await
        .expect("query")
        .expect("folder");
    assert_eq!((row.name.as_str(), row.kind.as_str()), ("Agenda", "folder"));

    // A personal calendar keeps them in the space of its channel.
    let mine = personal(&app, &alice).await;
    let personal_path = format!(
        "/api/v1/calendars/{}/attachment-folder",
        mine["id"].as_str().unwrap()
    );
    let (status, _) = get_json(&app, &alice, &personal_path).await;
    assert_eq!(status, 422);
    let (status, through) = get_json(
        &app,
        &alice,
        &format!("{personal_path}?channel={}", fx.public_channel),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(through["folder_id"], first["folder_id"]);
}

#[tokio::test]
async fn a_file_read_through_an_event_is_not_attached_again() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let dave = make_user(&app.db, "dave").await;
    let alice = app.cookie_for(fx.alice).await;
    let dave_cookie = app.cookie_for(dave).await;
    // Dave shares another space with Alice, not the one the file is in.
    let other = Uuid::new_v4();
    spaces::ActiveModel {
        id: Set(other),
        name: Set("Commun".to_owned()),
        slug: Set(format!("commun-{}", other.simple())),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("space");
    for user in [fx.alice, dave] {
        space_members::ActiveModel {
            space_id: Set(other),
            user_id: Set(user),
            role: Set("member".to_owned()),
            ..Default::default()
        }
        .insert(&app.db)
        .await
        .expect("member");
    }
    let secret = insert_file_row(&app.db, fx.space_id, fx.alice, "secret.pdf").await;
    let mine = personal(&app, &alice).await;
    let mut body = linked("Revue", None);
    body["attendees"] = json!([{ "user_id": dave }]);
    body["files"] = json!([secret]);
    assert_eq!(
        create_event(&app, &alice, &mine["id"], body).await.status(),
        201
    );
    // Dave reads it through the invitation, and may not pass it on through an event of his own.
    let his = personal(&app, &dave_cookie).await;
    let mut passed_on = linked("Relais", None);
    passed_on["files"] = json!([secret]);
    assert_eq!(
        create_event(&app, &dave_cookie, &his["id"], passed_on)
            .await
            .status(),
        422
    );
}

#[tokio::test]
async fn files_already_on_the_event_stay_when_someone_else_adds_one() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let alice = app.cookie_for(fx.alice).await;
    let bob = app.cookie_for(fx.bob).await;
    // A file of a space Alice is in and Bob is not.
    let other = Uuid::new_v4();
    spaces::ActiveModel {
        id: Set(other),
        name: Set("Ailleurs".to_owned()),
        slug: Set(format!("ailleurs-{}", other.simple())),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("space");
    space_members::ActiveModel {
        space_id: Set(other),
        user_id: Set(fx.alice),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("member");
    let hers = insert_file_row(&app.db, other, fx.alice, "devis.pdf").await;
    let his = insert_file_row(&app.db, fx.space_id, fx.bob, "plan.pdf").await;
    let general = space_default(&app, &alice, fx.space_id).await;
    let mut body = linked("Revue", None);
    body["files"] = json!([hers]);
    let created: Value = create_event(&app, &alice, &general["id"], body)
        .await
        .json()
        .await
        .expect("json");
    // Bob, who may write in the calendar, adds his own and sends the whole list back.
    let mut more = linked("Revue", None);
    more["files"] = json!([hers, his]);
    let changed = edit(&app, &bob, &created["event_id"], "", more).await;
    assert_eq!(changed.status(), 200);
    let changed: Value = changed.json().await.expect("json");
    assert_eq!(changed["files"].as_array().unwrap().len(), 2);
}
