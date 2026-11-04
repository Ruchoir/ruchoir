//! Setting, moving and removing a guest's end date after they joined, the list of ended access, and
//! reactivating an ended guest. Same harness as the parent module.

use super::delegation_tests::{assign, make_role};
use super::guest_expiry_tests::{exec, guest_ending};
use super::*;

use crate::calendar::recurrence;
use crate::permissions::guest_expiry;

struct Fx {
    space: Uuid,
    owner: Uuid,
    admin: Uuid,
    member: Uuid,
    /// A custom role holder with `members.manage` and nothing else.
    desk: Uuid,
}

async fn fx(app: &TestApp) -> Fx {
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Expiry").await;
    let admin = make_user(&app.db, "admin").await;
    crate::testkit::add_member(&app.db, space, admin, "admin").await;
    let member = make_user(&app.db, "member").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    let desk = make_user(&app.db, "desk").await;
    crate::testkit::add_member(&app.db, space, desk, "member").await;
    let front = make_role(&app.db, space, "Desk", 50, &["members.manage"]).await;
    assign(&app.db, space, desk, front).await;
    Fx {
        space,
        owner,
        admin,
        member,
        desk,
    }
}

fn in_days(days: i64) -> OffsetDateTime {
    OffsetDateTime::now_utc() + time::Duration::days(days)
}

pub(super) fn rfc(at: OffsetDateTime) -> String {
    crate::messaging::dto::rfc3339(at)
}

pub(super) async fn call(
    app: &TestApp,
    method: reqwest::Method,
    path: String,
    cookie: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let mut request = app.req(method, &path, cookie);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.expect("request");
    (
        response.status().as_u16(),
        response.json().await.unwrap_or(Value::Null),
    )
}

async fn put_expiry(
    app: &TestApp,
    space: Uuid,
    user: Uuid,
    cookie: &str,
    value: Value,
) -> (u16, Value) {
    call(
        app,
        reqwest::Method::PUT,
        format!("/api/v1/spaces/{space}/members/{user}/expiry"),
        cookie,
        Some(json!({ "expires_at": value })),
    )
    .await
}

async fn reactivate(
    app: &TestApp,
    space: Uuid,
    user: Uuid,
    cookie: &str,
    value: Value,
) -> (u16, Value) {
    call(
        app,
        reqwest::Method::POST,
        format!("/api/v1/spaces/{space}/members/{user}/reactivate"),
        cookie,
        Some(json!({ "expires_at": value })),
    )
    .await
}

async fn ended_list(app: &TestApp, space: Uuid, cookie: &str) -> (u16, Value) {
    call(
        app,
        reqwest::Method::GET,
        format!("/api/v1/spaces/{space}/members/ended"),
        cookie,
        None,
    )
    .await
}

pub(super) async fn row(app: &TestApp, space: Uuid, user: Uuid) -> space_members::Model {
    space_members::Entity::find_by_id((space, user))
        .one(&app.db)
        .await
        .expect("query")
        .expect("row")
}

pub(super) async fn audit(app: &TestApp, space: Uuid, action: &str) -> Vec<Value> {
    app.db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT details FROM space_audit_log WHERE space_id = $1 AND action = $2 \
             ORDER BY at, id",
            [space.into(), action.into()],
        ))
        .await
        .expect("log")
        .into_iter()
        .map(|row| row.try_get("", "details").expect("details"))
        .collect()
}

fn parse(value: &Value) -> OffsetDateTime {
    OffsetDateTime::parse(
        value.as_str().expect("a string"),
        &time::format_description::well_known::Rfc3339,
    )
    .expect("rfc3339")
}

async fn set_zone(app: &TestApp, user: Uuid, zone: &str) {
    exec(
        &app.db,
        "UPDATE users SET timezone = $2 WHERE id = $1",
        vec![user.into(), zone.into()],
    )
    .await
    .expect("zone");
}

pub(super) async fn frames(ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1000);
    let mut seen = Vec::new();
    while let Ok(Some(frame)) = tokio::time::timeout_at(deadline, ws.next()).await {
        if let Ok(WsMessage::Text(text)) = frame {
            if let Ok(event) = serde_json::from_str::<Value>(text.as_str()) {
                if let Some(kind) = event["type"].as_str() {
                    seen.push(kind.to_owned());
                }
            }
        }
    }
    seen
}

#[tokio::test]
async fn an_administrator_sets_moves_and_removes_a_guest_end() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "10 days").await;
    exec(
        &app.db,
        "UPDATE space_members SET expires_at = NULL WHERE space_id = $1 AND user_id = $2",
        vec![fx.space.into(), guest.into()],
    )
    .await
    .expect("no end");
    let cookie = app.cookie_for(fx.admin).await;
    // The administrator reads dates in Auckland: the chosen day ends there.
    set_zone(&app, fx.admin, "Pacific/Auckland").await;

    // A date: the end of that local day (23:59:59) in the zone of whoever sets it.
    let day = in_days(20).date();
    let (status, body) = put_expiry(
        &app,
        fx.space,
        guest,
        &cookie,
        json!(format!(
            "{}-{:02}-{:02}",
            day.year(),
            u8::from(day.month()),
            day.day()
        )),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["user_id"], guest.to_string());
    let stored = row(&app, fx.space, guest).await.expires_at.expect("set");
    assert_eq!(parse(&body["expires_at"]), stored);
    let (local_day, hour, minute) =
        recurrence::local_parts(stored, "Pacific/Auckland").expect("zone");
    assert_eq!((local_day, hour, minute), (day, 23, 59));
    assert_eq!(stored.second(), 59);

    // An instant is kept as it is.
    let instant = in_days(40);
    let (status, body) = put_expiry(&app, fx.space, guest, &cookie, json!(rfc(instant))).await;
    assert_eq!(status, 200, "{body}");
    let moved = row(&app, fx.space, guest).await.expires_at.expect("moved");
    assert!((moved - instant).whole_seconds().abs() <= 1);

    // Removed.
    let (status, body) = put_expiry(&app, fx.space, guest, &cookie, Value::Null).await;
    assert_eq!(status, 200, "{body}");
    assert!(body.get("expires_at").is_none_or(Value::is_null));
    assert!(row(&app, fx.space, guest).await.expires_at.is_none());

    let log = audit(&app, fx.space, "member.expiry_set").await;
    assert_eq!(log.len(), 3, "{log:?}");
    assert!(log[0]["before"].is_null());
    assert_eq!(parse(&log[0]["after"]), stored);
    assert_eq!(parse(&log[1]["before"]), stored);
    assert!((parse(&log[1]["after"]) - instant).whole_seconds().abs() <= 1);
    assert!((parse(&log[2]["before"]) - instant).whole_seconds().abs() <= 1);
    assert!(log[2]["after"].is_null());
}

#[tokio::test]
async fn a_plain_member_cannot_set_an_end() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "10 days").await;
    let before = row(&app, fx.space, guest).await.expires_at;
    let cookie = app.cookie_for(fx.member).await;
    let (status, _) = put_expiry(&app, fx.space, guest, &cookie, json!(rfc(in_days(30)))).await;
    assert_eq!(status, 403);
    assert_eq!(row(&app, fx.space, guest).await.expires_at, before);
    assert!(audit(&app, fx.space, "member.expiry_set").await.is_empty());
}

#[tokio::test]
async fn a_guest_cannot_extend_their_own_access() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "2 days").await;
    let before = row(&app, fx.space, guest).await.expires_at;
    let cookie = app.cookie_for(guest).await;
    let (status, _) = put_expiry(&app, fx.space, guest, &cookie, json!(rfc(in_days(300)))).await;
    assert_eq!(status, 403);
    let (status, _) = put_expiry(&app, fx.space, guest, &cookie, Value::Null).await;
    assert_eq!(status, 403);
    assert_eq!(row(&app, fx.space, guest).await.expires_at, before);

    // Nor can an ended guest bring themselves back, nor look at the ended list.
    let gone = guest_ending(&app.db, fx.space, "-1 hour").await;
    let gone_cookie = app.cookie_for(gone).await;
    let (status, _) = reactivate(&app, fx.space, gone, &gone_cookie, json!(rfc(in_days(30)))).await;
    assert_eq!(status, 403);
    assert_eq!(ended_list(&app, fx.space, &gone_cookie).await.0, 403);
    assert!(row(&app, fx.space, gone).await.expires_at.expect("still") < OffsetDateTime::now_utc());
}

#[tokio::test]
async fn an_end_on_a_member_is_refused() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let cookie = app.cookie_for(fx.admin).await;
    let (status, body) =
        put_expiry(&app, fx.space, fx.member, &cookie, json!(rfc(in_days(30)))).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "guest_only");
    let (status, body) = put_expiry(&app, fx.space, fx.member, &cookie, Value::Null).await;
    assert_eq!(status, 400, "{body}");
    assert!(row(&app, fx.space, fx.member).await.expires_at.is_none());
    // Someone above the administrator is refused by the delegation rule before anything else.
    let (status, _) = put_expiry(&app, fx.space, fx.owner, &cookie, json!(rfc(in_days(30)))).await;
    assert_eq!(status, 403);
    // An unknown person is a 404.
    let (status, _) = put_expiry(
        &app,
        fx.space,
        Uuid::new_v4(),
        &cookie,
        json!(rfc(in_days(30))),
    )
    .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn a_past_end_is_refused() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "10 days").await;
    let before = row(&app, fx.space, guest).await.expires_at;
    let cookie = app.cookie_for(fx.owner).await;
    let yesterday = in_days(-1).date();
    for bad in [
        json!(rfc(in_days(-1))),
        json!(format!(
            "{}-{:02}-{:02}",
            yesterday.year(),
            u8::from(yesterday.month()),
            yesterday.day()
        )),
        json!(rfc(in_days(365 * 5 + 30))),
        json!("next week"),
        json!("2026-13-45"),
    ] {
        let (status, body) = put_expiry(&app, fx.space, guest, &cookie, bad.clone()).await;
        assert_eq!(status, 400, "{bad}: {body}");
        assert_eq!(body["error"], "bad_expiry", "{bad}");
    }
    assert_eq!(row(&app, fx.space, guest).await.expires_at, before);
}

#[tokio::test]
async fn an_ended_guest_is_reactivated_not_edited() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let gone = guest_ending(&app.db, fx.space, "-1 hour").await;
    let cookie = app.cookie_for(fx.owner).await;
    let (status, body) = put_expiry(&app, fx.space, gone, &cookie, json!(rfc(in_days(30)))).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"], "access_ended");
}

#[tokio::test]
async fn reactivation_needs_members_manage_and_rank() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let new_end = json!(rfc(in_days(30)));
    let gone = guest_ending(&app.db, fx.space, "-1 hour").await;
    let other_guest = guest_ending(&app.db, fx.space, "10 days").await;

    // Refused: an active guest, a member without members.manage.
    for who in [other_guest, fx.member] {
        let cookie = app.cookie_for(who).await;
        let (status, _) = reactivate(&app, fx.space, gone, &cookie, new_end.clone()).await;
        assert_eq!(status, 403, "{who}");
    }
    assert!(row(&app, fx.space, gone).await.expires_at.expect("end") < OffsetDateTime::now_utc());

    // Refused, and not an ended guest: a member, an owner, an active guest.
    let owner_cookie = app.cookie_for(fx.owner).await;
    for target in [fx.member, other_guest] {
        let (status, body) =
            reactivate(&app, fx.space, target, &owner_cookie, new_end.clone()).await;
        assert_eq!(status, 409, "{target}: {body}");
        assert_eq!(body["error"], "not_ended");
    }
    let admin_cookie = app.cookie_for(fx.admin).await;
    let (status, _) = reactivate(&app, fx.space, fx.owner, &admin_cookie, new_end.clone()).await;
    assert_eq!(status, 403, "an administrator does not outrank the owner");

    // Accepted: the owner, an administrator, and a holder of members.manage.
    for (who, ending) in [
        (fx.owner, "-1 hour"),
        (fx.admin, "-2 days"),
        (fx.desk, "-3 days"),
    ] {
        let target = guest_ending(&app.db, fx.space, ending).await;
        let cookie = app.cookie_for(who).await;
        let (status, body) = reactivate(&app, fx.space, target, &cookie, new_end.clone()).await;
        assert_eq!(status, 200, "{who}: {body}");
        assert_eq!(body["user_id"], target.to_string());
        assert!(
            row(&app, fx.space, target).await.expires_at.expect("end") > OffsetDateTime::now_utc()
        );
    }

    // A past date, or none-and-then-a-bad-one, does not reactivate.
    let again = guest_ending(&app.db, fx.space, "-1 hour").await;
    let (status, body) = reactivate(
        &app,
        fx.space,
        again,
        &owner_cookie,
        json!(rfc(in_days(-1))),
    )
    .await;
    assert_eq!((status, body["error"].as_str()), (400, Some("bad_expiry")));
    // Without an end date at all, the access has no end: allowed.
    let (status, body) = reactivate(&app, fx.space, again, &owner_cookie, Value::Null).await;
    assert_eq!(status, 200, "{body}");
    assert!(row(&app, fx.space, again).await.expires_at.is_none());
    assert_eq!(audit(&app, fx.space, "member.reactivated").await.len(), 4);
}

#[tokio::test]
async fn reactivation_restores_the_same_access() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let general: Uuid = spaces::Entity::find_by_id(fx.space)
        .one(&app.db)
        .await
        .expect("space")
        .expect("row")
        .default_channel_id
        .expect("general");
    let gone = guest_ending(&app.db, fx.space, "10 days").await;
    exec(
        &app.db,
        "INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'member')",
        vec![general.into(), gone.into()],
    )
    .await
    .expect("channel");
    let group = Uuid::new_v4();
    exec(
        &app.db,
        "INSERT INTO space_groups (id, space_id, name) VALUES ($1, $2, 'Clients')",
        vec![group.into(), fx.space.into()],
    )
    .await
    .expect("group");
    exec(
        &app.db,
        "INSERT INTO space_group_members (group_id, space_id, user_id) VALUES ($1, $2, $3)",
        vec![group.into(), fx.space.into(), gone.into()],
    )
    .await
    .expect("group member");
    // A rule of their own (a role assignment), so something beyond channel and group is kept.
    let role = make_role(&app.db, fx.space, "Reader", 5, &["message.react"]).await;
    exec(
        &app.db,
        "INSERT INTO space_role_assignments (space_id, user_id, role_id) VALUES ($1, $2, $3)",
        vec![fx.space.into(), gone.into(), role.into()],
    )
    .await
    .expect("assignment");
    let counts = || async {
        let row = app
            .db
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "SELECT (SELECT count(*) FROM channel_members WHERE user_id = $1) AS c, \
                        (SELECT count(*) FROM space_group_members WHERE user_id = $1) AS g, \
                        (SELECT count(*) FROM space_role_assignments WHERE user_id = $1) AS r, \
                        (SELECT joined_at FROM space_members WHERE user_id = $1 AND space_id = $2) AS j",
                [gone.into(), fx.space.into()],
            ))
            .await
            .expect("count")
            .expect("row");
        (
            row.try_get::<i64>("", "c").expect("c"),
            row.try_get::<i64>("", "g").expect("g"),
            row.try_get::<i64>("", "r").expect("r"),
            row.try_get::<OffsetDateTime>("", "j").expect("j"),
        )
    };
    let guest_cookie = app.cookie_for(gone).await;
    let owner_cookie = app.cookie_for(fx.owner).await;
    let say = |cookie: String| {
        let app = &app;
        async move {
            call(
                app,
                reqwest::Method::POST,
                format!("/api/v1/conversations/{general}/messages"),
                &cookie,
                Some(json!({ "body": "hello" })),
            )
            .await
            .0
        }
    };
    assert_eq!(say(guest_cookie.clone()).await, 201, "in, before the end");
    let before = counts().await;

    exec(
        &app.db,
        "UPDATE space_members SET expires_at = now() - interval '1 hour' \
         WHERE space_id = $1 AND user_id = $2",
        vec![fx.space.into(), gone.into()],
    )
    .await
    .expect("end it");
    assert_eq!(say(guest_cookie.clone()).await, 403, "out, after the end");

    let (status, body) =
        reactivate(&app, fx.space, gone, &owner_cookie, json!(rfc(in_days(14)))).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(counts().await, before, "nothing recreated, nothing lost");
    assert_eq!(say(guest_cookie).await, 201, "back in, as it was");
    let (_, listed) = ended_list(&app, fx.space, &owner_cookie).await;
    assert!(listed.as_array().expect("list").is_empty());
}

#[tokio::test]
async fn reactivation_restarts_the_reminders() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let owner_cookie = app.cookie_for(fx.owner).await;
    let long_ago = |user: Uuid| {
        exec(
            &app.db,
            "UPDATE space_members SET joined_at = now() - interval '30 days' \
             WHERE space_id = $1 AND user_id = $2",
            vec![fx.space.into(), user.into()],
        )
    };

    // An ended and announced guest (stage 0), brought back for six days: reminded again.
    let gone = guest_ending(&app.db, fx.space, "-1 hour").await;
    long_ago(gone).await.expect("joined long ago");
    exec(
        &app.db,
        "UPDATE space_members SET expiry_stage = 0, expiry_notice_sent_at = now() \
         WHERE space_id = $1 AND user_id = $2",
        vec![fx.space.into(), gone.into()],
    )
    .await
    .expect("announced");
    let (status, _) = reactivate(&app, fx.space, gone, &owner_cookie, json!(rfc(in_days(6)))).await;
    assert_eq!(status, 200);
    let after = row(&app, fx.space, gone).await;
    assert_eq!(
        (after.expiry_stage, after.expiry_notice_sent_at),
        (None, None)
    );
    let report = guest_expiry::sweep_in(&app.state, OffsetDateTime::now_utc(), Some(fx.space))
        .await
        .expect("sweep");
    assert_eq!(report.reminded, 1);

    // Moving a reminded guest's date starts over; removing it clears the stage too.
    let guest = guest_ending(&app.db, fx.space, "6 days").await;
    long_ago(guest).await.expect("joined long ago");
    guest_expiry::sweep_in(&app.state, OffsetDateTime::now_utc(), Some(fx.space))
        .await
        .expect("sweep");
    assert_eq!(row(&app, fx.space, guest).await.expiry_stage, Some(7));
    let (status, _) = put_expiry(
        &app,
        fx.space,
        guest,
        &owner_cookie,
        json!(rfc(in_days(60))),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(row(&app, fx.space, guest).await.expiry_stage, None);
    guest_expiry::sweep_in(
        &app.state,
        OffsetDateTime::now_utc() + time::Duration::days(54),
        Some(fx.space),
    )
    .await
    .expect("sweep");
    assert_eq!(row(&app, fx.space, guest).await.expiry_stage, Some(7));
    let (status, _) = put_expiry(&app, fx.space, guest, &owner_cookie, Value::Null).await;
    assert_eq!(status, 200);
    let cleared = row(&app, fx.space, guest).await;
    assert_eq!(
        (cleared.expiry_stage, cleared.expiry_notice_sent_at),
        (None, None)
    );
}

#[tokio::test]
async fn ended_lists_for_managers_only() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let newest = guest_ending(&app.db, fx.space, "-1 day").await;
    let oldest = guest_ending(&app.db, fx.space, "-30 days").await;
    let still_in = guest_ending(&app.db, fx.space, "5 days").await;
    exec(
        &app.db,
        "UPDATE users SET display_name = 'Zoe Ended', title = 'Auditor' WHERE id = $1",
        vec![oldest.into()],
    )
    .await
    .expect("name");

    for who in [fx.member, still_in] {
        let cookie = app.cookie_for(who).await;
        assert_eq!(ended_list(&app, fx.space, &cookie).await.0, 403, "{who}");
    }
    for who in [fx.owner, fx.admin, fx.desk] {
        let cookie = app.cookie_for(who).await;
        let (status, body) = ended_list(&app, fx.space, &cookie).await;
        assert_eq!(status, 200, "{who}");
        let ids: Vec<&str> = body
            .as_array()
            .expect("list")
            .iter()
            .map(|e| e["user_id"].as_str().expect("id"))
            .collect();
        // Oldest purge first, nobody who is still in.
        assert_eq!(ids, vec![oldest.to_string(), newest.to_string()]);
        assert_eq!(body[0]["display_name"], "Zoe Ended");
        assert_eq!(body[0]["title"], "Auditor");
        assert!(parse(&body[0]["ended_at"]) < OffsetDateTime::now_utc());
        assert_eq!(body[0]["days_left_to_keep"], 60);
        assert_eq!(body[1]["days_left_to_keep"], 89);
    }
}

#[tokio::test]
async fn a_removed_for_good_guest_leaves_the_list() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let gone = guest_ending(&app.db, fx.space, "-2 days").await;
    let cookie = app.cookie_for(fx.admin).await;
    assert_eq!(
        ended_list(&app, fx.space, &cookie)
            .await
            .1
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    let (status, _) = call(
        &app,
        reqwest::Method::DELETE,
        format!("/api/v1/spaces/{}/members/{gone}", fx.space),
        &cookie,
        None,
    )
    .await;
    assert_eq!(status, 204);
    assert_eq!(
        ended_list(&app, fx.space, &cookie)
            .await
            .1
            .as_array()
            .map(Vec::len),
        Some(0)
    );
    assert!(space_members::Entity::find_by_id((fx.space, gone))
        .one(&app.db)
        .await
        .expect("query")
        .is_none());
}

#[tokio::test]
async fn the_member_list_shows_standing_and_end_to_managers_and_to_the_person_only() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "10 days").await;
    let other = guest_ending(&app.db, fx.space, "20 days").await;
    let general: Uuid = spaces::Entity::find_by_id(fx.space)
        .one(&app.db)
        .await
        .expect("space")
        .expect("row")
        .default_channel_id
        .expect("general");
    for user in [guest, other] {
        exec(
            &app.db,
            "INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'member')",
            vec![general.into(), user.into()],
        )
        .await
        .expect("channel");
    }
    let list = |who: Uuid| {
        let app = &app;
        let space = fx.space;
        async move {
            let cookie = app.cookie_for(who).await;
            call(
                app,
                reqwest::Method::GET,
                format!("/api/v1/spaces/{space}/members"),
                &cookie,
                None,
            )
            .await
            .1
        }
    };
    let entry = |list: &Value, id: Uuid| {
        list.as_array()
            .expect("list")
            .iter()
            .find(|m| m["user_id"] == id.to_string())
            .cloned()
    };

    // A manager sees every standing and every end.
    for manager in [fx.owner, fx.desk] {
        let seen = list(manager).await;
        let g = entry(&seen, guest).expect("guest");
        assert_eq!(g["standing"], "guest");
        assert!(g["expires_at"].is_string());
        assert_eq!(
            entry(&seen, fx.member).expect("member")["standing"],
            "member"
        );
        assert!(entry(&seen, fx.member)
            .expect("member")
            .get("expires_at")
            .is_none());
    }
    // The person sees their own, and nobody else's.
    let own = list(guest).await;
    assert_eq!(entry(&own, guest).expect("self")["standing"], "guest");
    assert!(entry(&own, guest).expect("self")["expires_at"].is_string());
    let theirs = entry(&own, other).expect("shares a channel");
    assert!(
        theirs.get("standing").is_none() && theirs.get("expires_at").is_none(),
        "{theirs}"
    );
    // A plain member sees neither, for anyone.
    for m in list(fx.member).await.as_array().expect("list") {
        if m["user_id"] == fx.member.to_string() {
            continue; // their own, which they may see
        }
        assert!(
            m.get("standing").is_none() && m.get("expires_at").is_none(),
            "{m}"
        );
    }
}

#[tokio::test]
async fn the_space_dto_carries_my_end_date() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "10 days").await;
    let ends = row(&app, fx.space, guest).await.expires_at.expect("end");
    let mine = |who: Uuid| {
        let app = &app;
        let space = fx.space;
        async move {
            let cookie = app.cookie_for(who).await;
            let (_, spaces) = call(
                app,
                reqwest::Method::GET,
                "/api/v1/me/spaces".to_owned(),
                &cookie,
                None,
            )
            .await;
            spaces
                .as_array()
                .expect("spaces")
                .iter()
                .find(|s| s["id"] == space.to_string())
                .cloned()
                .expect("space")
        }
    };
    assert_eq!(parse(&mine(guest).await["expires_at"]), ends);
    assert!(mine(fx.owner).await.get("expires_at").is_none());
    assert!(mine(fx.member).await.get("expires_at").is_none());
}

#[tokio::test]
async fn every_expiry_write_is_logged_and_announced() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "10 days").await;
    let gone = guest_ending(&app.db, fx.space, "-1 hour").await;
    let owner_cookie = app.cookie_for(fx.owner).await;
    let member_cookie = app.cookie_for(fx.member).await;
    let mut ws = app.connect_ws(&member_cookie).await;
    frames(&mut ws).await;
    let changed = |seen: &[String]| seen.iter().filter(|k| *k == "permissions.changed").count();

    put_expiry(
        &app,
        fx.space,
        guest,
        &owner_cookie,
        json!(rfc(in_days(50))),
    )
    .await;
    assert_eq!(changed(&frames(&mut ws).await), 1);
    put_expiry(&app, fx.space, guest, &owner_cookie, Value::Null).await;
    assert_eq!(changed(&frames(&mut ws).await), 1);
    reactivate(&app, fx.space, gone, &owner_cookie, json!(rfc(in_days(9)))).await;
    assert_eq!(changed(&frames(&mut ws).await), 1);

    // Refusals announce and log nothing.
    put_expiry(
        &app,
        fx.space,
        fx.member,
        &owner_cookie,
        json!(rfc(in_days(9))),
    )
    .await;
    put_expiry(&app, fx.space, guest, &member_cookie, Value::Null).await;
    assert_eq!(changed(&frames(&mut ws).await), 0);
    assert_eq!(audit(&app, fx.space, "member.expiry_set").await.len(), 2);
    let log = audit(&app, fx.space, "member.reactivated").await;
    assert_eq!(log.len(), 1);
    assert!(log[0]["before"].is_string());
    assert!(log[0]["after"].is_string());
}

#[tokio::test]
async fn the_role_change_can_carry_the_end_in_the_same_write() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let cookie = app.cookie_for(fx.owner).await;
    let path = format!("/api/v1/spaces/{}/members/{}", fx.space, fx.member);

    // Only with `role: guest`.
    let (status, body) = call(
        &app,
        reqwest::Method::PATCH,
        path.clone(),
        &cookie,
        Some(json!({ "role": "member", "expires_at": rfc(in_days(30)) })),
    )
    .await;
    assert_eq!((status, body["error"].as_str()), (400, Some("guest_only")));
    // A bad date changes nothing, not even the role.
    let (status, body) = call(
        &app,
        reqwest::Method::PATCH,
        path.clone(),
        &cookie,
        Some(json!({ "role": "guest", "expires_at": rfc(in_days(-3)) })),
    )
    .await;
    assert_eq!((status, body["error"].as_str()), (400, Some("bad_expiry")));
    assert_eq!(row(&app, fx.space, fx.member).await.role, "member");

    let end = in_days(30);
    let (status, body) = call(
        &app,
        reqwest::Method::PATCH,
        path.clone(),
        &cookie,
        Some(json!({ "role": "guest", "expires_at": rfc(end) })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let after = row(&app, fx.space, fx.member).await;
    assert_eq!(after.role, "guest");
    assert!((after.expires_at.expect("end") - end).whole_seconds().abs() <= 1);
    assert_eq!(audit(&app, fx.space, "member.expiry_set").await.len(), 1);

    // Without it the role change is as before, and back to member clears the end.
    let (status, _) = call(
        &app,
        reqwest::Method::PATCH,
        path,
        &cookie,
        Some(json!({ "role": "member" })),
    )
    .await;
    assert_eq!(status, 200);
    assert!(row(&app, fx.space, fx.member).await.expires_at.is_none());
}

#[tokio::test]
async fn the_routes_keep_the_contract() {
    let Some(app) = boot().await else { return };
    // Listed for the apps that ask, and drawn in the contract.
    let (_, info) = call(
        &app,
        reqwest::Method::GET,
        "/api/v1/instance".to_owned(),
        "",
        None,
    )
    .await;
    let text = info.to_string();
    assert!(text.contains("guest_expiry"), "{text}");
    let spec = serde_json::to_value(<crate::openapi::ApiDoc as utoipa::OpenApi>::openapi())
        .expect("openapi");
    let paths = &spec["paths"];
    assert!(paths["/api/v1/spaces/{space_id}/members/{user_id}/expiry"]["put"].is_object());
    assert!(paths["/api/v1/spaces/{space_id}/members/ended"]["get"].is_object());
    assert!(paths["/api/v1/spaces/{space_id}/members/{user_id}/reactivate"]["post"].is_object());
}

#[tokio::test]
async fn reactivation_stops_where_the_list_stops() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let cookie = app.cookie_for(fx.owner).await;
    let stale = guest_ending(&app.db, fx.space, "-91 days").await;
    let (status, body) = reactivate(&app, fx.space, stale, &cookie, json!(rfc(in_days(9)))).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (409, Some("access_ended_for_good"))
    );
    assert!(row(&app, fx.space, stale).await.expires_at.expect("end") < OffsetDateTime::now_utc());
    let kept = guest_ending(&app.db, fx.space, "-89 days").await;
    let (status, _) = reactivate(&app, fx.space, kept, &cookie, json!(rfc(in_days(9)))).await;
    assert_eq!(status, 200);
}

/// Keep window edges: one span, 2160 hours, for the route and for the purge.
#[tokio::test]
async fn the_keeping_window_is_2160_hours_for_the_route_and_the_purge() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let owner = app.cookie_for(fx.owner).await;
    let inside = guest_ending(&app.db, fx.space, "-2159 hours -59 minutes").await;
    let outside = guest_ending(&app.db, fx.space, "-2160 hours -1 minutes").await;

    let (status, body) = reactivate(&app, fx.space, outside, &owner, json!(rfc(in_days(30)))).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"], "access_ended_for_good");

    let report = guest_expiry::sweep_in(&app.state, OffsetDateTime::now_utc(), Some(fx.space))
        .await
        .expect("sweep");
    assert_eq!(report.purged, 1);
    assert!(space_members::Entity::find_by_id((fx.space, outside))
        .one(&app.db)
        .await
        .expect("query")
        .is_none());
    assert!(space_members::Entity::find_by_id((fx.space, inside))
        .one(&app.db)
        .await
        .expect("query")
        .is_some());

    let (status, body) = reactivate(&app, fx.space, inside, &owner, json!(rfc(in_days(30)))).await;
    assert_eq!(status, 200, "{body}");
}

/// The sweep closes an access on the database's clock, whatever the process thinks the time is.
#[tokio::test]
async fn the_sweep_closes_an_access_on_the_database_clock() {
    let Some(app) = boot().await else { return };
    let fx = fx(&app).await;
    let guest = guest_ending(&app.db, fx.space, "2 seconds").await;

    // A process clock running an hour ahead must not close it early.
    let early = guest_expiry::sweep_in(
        &app.state,
        OffsetDateTime::now_utc() + time::Duration::hours(1),
        Some(fx.space),
    )
    .await
    .expect("sweep");
    assert!(early.expired.is_empty(), "{:?}", early.expired);

    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    let late = guest_expiry::sweep_in(&app.state, OffsetDateTime::now_utc(), Some(fx.space))
        .await
        .expect("sweep");
    assert_eq!(late.expired, vec![(fx.space, guest)]);
}
