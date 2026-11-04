//! The audit log against a real database: written by `audit::record` alone, never updated or
//! deleted by anything but the database's own cascades. Same harness as the parent module.

use super::*;

use crate::audit::{record, Action, Target};

async fn entries(db: &DatabaseConnection, space_id: Uuid) -> Vec<(String, Option<Uuid>)> {
    db.query_all_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT action, actor_id FROM space_audit_log WHERE space_id = $1 ORDER BY at",
        [space_id.into()],
    ))
    .await
    .expect("entries")
    .into_iter()
    .map(|row| {
        (
            row.try_get::<String>("", "action").expect("action"),
            row.try_get::<Option<Uuid>>("", "actor_id").expect("actor"),
        )
    })
    .collect()
}

#[tokio::test]
async fn the_audit_log_refuses_updates_and_deletes() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    record(
        &app.db,
        space,
        Some(owner),
        Action::MemberJoined,
        Target::Member(owner),
        json!({ "role": "owner" }),
    )
    .await
    .expect("record");
    for statement in [
        "UPDATE space_audit_log SET action = 'role.deleted' WHERE space_id = $1",
        "UPDATE space_audit_log SET details = '{}' WHERE space_id = $1",
        "DELETE FROM space_audit_log WHERE space_id = $1",
    ] {
        let refused = app
            .db
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                statement,
                [space.into()],
            ))
            .await;
        assert!(refused.is_err(), "{statement} was allowed");
    }
    assert_eq!(
        entries(&app.db, space).await,
        vec![("member.joined".to_owned(), Some(owner))]
    );
}

#[tokio::test]
async fn a_deleted_account_leaves_anonymous_rows() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let actor = make_user(&app.db, "leaving").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    record(
        &app.db,
        space,
        Some(actor),
        Action::MemberRemoved,
        Target::Member(owner),
        json!({}),
    )
    .await
    .expect("record");
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM users WHERE id = $1",
            [actor.into()],
        ))
        .await
        .expect("account deleted");
    assert_eq!(
        entries(&app.db, space).await,
        vec![("member.removed".to_owned(), None)]
    );
}

#[tokio::test]
async fn a_deleted_space_takes_its_log() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    record(
        &app.db,
        space,
        Some(owner),
        Action::RoleCreated,
        Target::Role(Uuid::new_v4()),
        json!({ "name": "Comptable" }),
    )
    .await
    .expect("record");
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM spaces WHERE id = $1",
            [space.into()],
        ))
        .await
        .expect("space deleted");
    assert!(entries(&app.db, space).await.is_empty());
}

#[test]
fn no_code_writes_to_the_audit_log_but_record() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut stack = vec![src.clone()];
    let mut offenders = Vec::new();
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let relative = path
                .strip_prefix(&src)
                .expect("inside src")
                .to_string_lossy()
                .to_string();
            // The writer itself, its entity, and the tests (this one included) may name the table.
            if relative.starts_with("audit/")
                || relative == "entities/space_audit_log.rs"
                || relative.starts_with("tests_integration")
            {
                if relative.starts_with("audit/") {
                    let text = std::fs::read_to_string(&path).expect("read");
                    let upper = text.to_uppercase();
                    if upper.contains("UPDATE SPACE_AUDIT_LOG")
                        || upper.contains("DELETE FROM SPACE_AUDIT_LOG")
                    {
                        offenders.push(format!("{relative}: changes rows"));
                    }
                }
                continue;
            }
            if path.extension().is_some_and(|e| e == "rs") {
                let text = std::fs::read_to_string(&path).expect("read");
                if text.contains("space_audit_log") {
                    offenders.push(relative);
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "the audit log is written by audit::record alone: {offenders:?}"
    );
}

/// Every entry of a space: action, actor, target kind and id, details.
async fn log_of(
    db: &DatabaseConnection,
    space_id: Uuid,
) -> Vec<(String, Option<Uuid>, String, Option<Uuid>, Value)> {
    db.query_all_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT action, actor_id, target_kind, target_id, details FROM space_audit_log \
         WHERE space_id = $1 ORDER BY at, id",
        [space_id.into()],
    ))
    .await
    .expect("log")
    .into_iter()
    .map(|row| {
        (
            row.try_get("", "action").expect("action"),
            row.try_get("", "actor_id").expect("actor"),
            row.try_get("", "target_kind").expect("kind"),
            row.try_get("", "target_id").expect("target"),
            row.try_get("", "details").expect("details"),
        )
    })
    .collect()
}

async fn patch(app: &TestApp, cookie: &str, path: &str, body: Value) -> reqwest::Response {
    app.req(reqwest::Method::PATCH, path, cookie)
        .json(&body)
        .send()
        .await
        .expect("patch")
}

#[tokio::test]
async fn an_arrival_is_logged() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    let created: Value = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{space}/invitations"),
            &app.cookie_for(owner).await,
        )
        .json(&json!({ "role": "member" }))
        .send()
        .await
        .expect("invite")
        .json()
        .await
        .expect("json");
    let newcomer = make_user(&app.db, "newcomer").await;
    let accepted = app
        .req(
            reqwest::Method::POST,
            &format!(
                "/api/v1/invitations/{}/accept",
                token_of(created["url"].as_str().expect("url"))
            ),
            &app.cookie_for(newcomer).await,
        )
        .send()
        .await
        .expect("accept");
    assert_eq!(accepted.status(), 200);
    let log = log_of(&app.db, space).await;
    assert_eq!(log.len(), 1, "{log:?}");
    let (action, actor, kind, target, details) = &log[0];
    assert_eq!(action, "member.joined");
    assert_eq!(*actor, Some(newcomer));
    assert_eq!((kind.as_str(), *target), ("member", Some(newcomer)));
    assert_eq!(details["role"], "member");
    assert_eq!(details["invited_by"], owner.to_string());
}

#[tokio::test]
async fn a_departure_and_a_removal_are_logged() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let leaving = make_user(&app.db, "leaving").await;
    let removed = make_user(&app.db, "removed").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    crate::testkit::add_member(&app.db, space, leaving, "member").await;
    crate::testkit::add_member(&app.db, space, removed, "guest").await;
    let left = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{space}/membership"),
            &app.cookie_for(leaving).await,
        )
        .send()
        .await
        .expect("leave");
    assert!(left.status().is_success(), "{}", left.status());
    let gone = app
        .req(
            reqwest::Method::DELETE,
            &format!("/api/v1/spaces/{space}/members/{removed}"),
            &app.cookie_for(owner).await,
        )
        .send()
        .await
        .expect("remove");
    assert!(gone.status().is_success(), "{}", gone.status());
    let log = log_of(&app.db, space).await;
    let summary: Vec<_> = log
        .iter()
        .map(|(action, actor, _, target, details)| {
            (action.as_str(), *actor, *target, details["role"].clone())
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            ("member.left", Some(leaving), Some(leaving), json!("member")),
            ("member.removed", Some(owner), Some(removed), json!("guest")),
        ]
    );
}

#[tokio::test]
async fn a_role_change_is_logged_with_before_and_after() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let member = make_user(&app.db, "member").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    let cookie = app.cookie_for(owner).await;
    let path = format!("/api/v1/spaces/{space}/members/{member}");
    for _ in 0..2 {
        assert_eq!(
            patch(&app, &cookie, &path, json!({ "role": "admin" }))
                .await
                .status(),
            200
        );
    }
    let log = log_of(&app.db, space).await;
    assert_eq!(
        log.len(),
        1,
        "the second, unchanged, writes nothing: {log:?}"
    );
    let (action, actor, kind, target, details) = &log[0];
    assert_eq!(action, "member.role_changed");
    assert_eq!(*actor, Some(owner));
    assert_eq!((kind.as_str(), *target), ("member", Some(member)));
    assert_eq!(details, &json!({ "before": "member", "after": "admin" }));
}

#[tokio::test]
async fn a_transfer_is_logged_once() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let heir = make_user(&app.db, "heir").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    crate::testkit::add_member(&app.db, space, heir, "admin").await;
    let path = format!("/api/v1/spaces/{space}/members/{heir}");
    let handed = patch(
        &app,
        &app.cookie_for(owner).await,
        &path,
        json!({ "role": "owner" }),
    )
    .await;
    assert_eq!(handed.status(), 200);
    let log = log_of(&app.db, space).await;
    let actions: Vec<&str> = log.iter().map(|entry| entry.0.as_str()).collect();
    assert_eq!(
        actions,
        vec![
            "member.role_changed",
            "member.role_changed",
            "space.ownership_transferred"
        ],
        "{log:?}"
    );
    let transfer = &log[2].4;
    assert_eq!(
        transfer,
        &json!({ "from": owner.to_string(), "to": heir.to_string() })
    );
    assert_eq!(log[0].4, json!({ "before": "admin", "after": "owner" }));
    assert_eq!(log[1].3, Some(owner));
    assert_eq!(log[1].4, json!({ "before": "owner", "after": "admin" }));
}

#[tokio::test]
async fn a_reservation_is_logged() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    let channel = make_channel(&app.db, space, "direction", "public").await;
    let cookie = app.cookie_for(owner).await;
    let path = format!("/api/v1/channels/{channel}");
    for _ in 0..2 {
        let reserved = patch(&app, &cookie, &path, json!({ "allowed_roles": ["admin"] })).await;
        assert_eq!(reserved.status(), 200);
    }
    let lifted = patch(&app, &cookie, &path, json!({ "allowed_roles": [] })).await;
    assert_eq!(lifted.status(), 200);
    let log = log_of(&app.db, space).await;
    let summary: Vec<_> = log
        .iter()
        .map(|(action, actor, kind, target, details)| {
            (
                action.as_str(),
                *actor,
                kind.as_str(),
                *target,
                details.clone(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            (
                "channel.reserved",
                Some(owner),
                "channel",
                Some(channel),
                json!({ "name": "direction", "before": [], "after": ["admin"] })
            ),
            (
                "channel.reserved",
                Some(owner),
                "channel",
                Some(channel),
                json!({ "name": "direction", "before": ["admin"], "after": [] })
            ),
        ]
    );
}

#[tokio::test]
async fn a_calendar_closed_to_members_is_logged() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    let cookie = app.cookie_for(owner).await;
    let created: Value = app
        .req(reqwest::Method::POST, &format!("/api/v1/spaces/{space}/calendars"), &cookie)
        .json(&json!({ "name": "Chantiers", "color": "lime", "write_access": "members", "default_reminders": [] }))
        .send()
        .await
        .expect("create")
        .json()
        .await
        .expect("json");
    let calendar: Uuid = created["id"].as_str().expect("id").parse().expect("uuid");
    let path = format!("/api/v1/calendars/{calendar}");
    for _ in 0..2 {
        assert_eq!(
            patch(&app, &cookie, &path, json!({ "write_access": "admins" }))
                .await
                .status(),
            200
        );
    }
    let log = log_of(&app.db, space).await;
    assert_eq!(log.len(), 1, "{log:?}");
    let (action, actor, kind, target, details) = &log[0];
    assert_eq!(action, "calendar.write_access_changed");
    assert_eq!(*actor, Some(owner));
    assert_eq!((kind.as_str(), *target), ("calendar", Some(calendar)));
    assert_eq!(
        details,
        &json!({ "name": "Chantiers", "before": "members", "after": "admins" })
    );
}

async fn read_log(app: &TestApp, cookie: &str, space_id: Uuid, query: &str) -> (u16, Value) {
    let response = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{space_id}/audit{query}"),
            cookie,
        )
        .send()
        .await
        .expect("read log");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn an_administrator_reads_the_log_newest_first() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "Camille").await;
    let admin = make_user(&app.db, "Sophie").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    crate::testkit::add_member(&app.db, space, admin, "admin").await;
    let role = Uuid::new_v4();
    record(
        &app.db,
        space,
        Some(owner),
        Action::MemberJoined,
        Target::Member(owner),
        json!({ "role": "owner" }),
    )
    .await
    .expect("record");
    record(
        &app.db,
        space,
        Some(admin),
        Action::RoleCreated,
        Target::Role(role),
        json!({ "name": "Comptable", "permissions": ["files.manage"] }),
    )
    .await
    .expect("record");
    let (status, body) = read_log(&app, &app.cookie_for(admin).await, space, "").await;
    assert_eq!(status, 200, "{body}");
    let entries = body["entries"].as_array().expect("entries");
    assert_eq!(entries.len(), 2);
    let newest = &entries[0];
    assert_eq!(newest["action"], "role.created");
    assert_eq!(newest["category"], "roles");
    assert_eq!(newest["actor"]["id"], admin.to_string());
    assert_eq!(newest["actor"]["display_name"], "Sophie");
    assert_eq!(newest["target"]["kind"], "role");
    assert_eq!(newest["target"]["id"], role.to_string());
    // The role is gone (never existed here): its name is the one the entry kept.
    assert_eq!(newest["target"]["label"], "Comptable");
    assert_eq!(newest["details"]["permissions"], json!(["files.manage"]));
    assert!(newest["at"].as_str().expect("at").ends_with('Z'));
    assert_eq!(entries[1]["action"], "member.joined");
    assert_eq!(entries[1]["target"]["label"], "Camille");
    assert!(body.get("next").is_none(), "{body}");
}

#[tokio::test]
async fn a_member_without_audit_view_is_refused() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let member = make_user(&app.db, "member").await;
    let guest = make_user(&app.db, "guest").await;
    let stranger = make_user(&app.db, "stranger").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    crate::testkit::add_member(&app.db, space, guest, "guest").await;
    for person in [member, guest, stranger] {
        let (status, _) = read_log(&app, &app.cookie_for(person).await, space, "").await;
        assert_eq!(status, 403);
    }
    let (status, _) = read_log(&app, &app.cookie_for(owner).await, space, "").await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn the_log_filters_by_actor_and_category() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let admin = make_user(&app.db, "admin").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    crate::testkit::add_member(&app.db, space, admin, "admin").await;
    for (actor, action, target) in [
        (owner, Action::RoleCreated, Target::Role(Uuid::new_v4())),
        (admin, Action::RoleUpdated, Target::Role(Uuid::new_v4())),
        (admin, Action::MemberRemoved, Target::Member(owner)),
        (
            owner,
            Action::ChannelReserved,
            Target::Channel(Uuid::new_v4()),
        ),
    ] {
        record(&app.db, space, Some(actor), action, target, json!({}))
            .await
            .expect("record");
    }
    let cookie = app.cookie_for(owner).await;
    let actions = |body: &Value| -> Vec<String> {
        body["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .map(|e| e["action"].as_str().expect("action").to_owned())
            .collect()
    };
    let (_, body) = read_log(&app, &cookie, space, &format!("?actor={admin}")).await;
    assert_eq!(actions(&body), vec!["member.removed", "role.updated"]);
    let (_, body) = read_log(&app, &cookie, space, "?category=roles").await;
    assert_eq!(actions(&body), vec!["role.updated", "role.created"]);
    let (_, body) = read_log(
        &app,
        &cookie,
        space,
        &format!("?category=roles&actor={owner}"),
    )
    .await;
    assert_eq!(actions(&body), vec!["role.created"]);
    let (status, _) = read_log(&app, &cookie, space, "?category=everything").await;
    assert_eq!(status, 400);
    let (_, body) = read_log(&app, &cookie, space, "?since=2999-01-01T00:00:00Z").await;
    assert!(actions(&body).is_empty());
}

#[tokio::test]
async fn the_log_pages_without_gaps_or_repeats() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    for i in 0..130 {
        record(
            &app.db,
            space,
            Some(owner),
            Action::RoleUpdated,
            Target::Role(Uuid::new_v4()),
            json!({ "i": i }),
        )
        .await
        .expect("record");
    }
    let cookie = app.cookie_for(owner).await;
    let mut seen = Vec::new();
    let mut query = "?limit=50".to_owned();
    let mut pages = 0;
    loop {
        let (status, body) = read_log(&app, &cookie, space, &query).await;
        assert_eq!(status, 200, "{body}");
        pages += 1;
        for entry in body["entries"].as_array().expect("entries") {
            seen.push(entry["details"]["i"].as_i64().expect("i"));
        }
        match body.get("next").and_then(Value::as_str) {
            Some(next) => query = format!("?limit=50&before={next}"),
            None => break,
        }
    }
    assert_eq!(pages, 3);
    assert_eq!(seen, (0..130).rev().collect::<Vec<i64>>());
    let (status, _) = read_log(&app, &cookie, space, "?limit=500").await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn the_log_never_shows_another_space() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let here = crate::testkit::make_space(&app.db, owner, "Here").await;
    let there = crate::testkit::make_space(&app.db, owner, "There").await;
    record(
        &app.db,
        there,
        Some(owner),
        Action::RoleDeleted,
        Target::Role(Uuid::new_v4()),
        json!({}),
    )
    .await
    .expect("record");
    let (status, body) = read_log(&app, &app.cookie_for(owner).await, here, "").await;
    assert_eq!(status, 200);
    assert!(
        body["entries"].as_array().expect("entries").is_empty(),
        "{body}"
    );
}

#[tokio::test]
async fn the_guest_actions_have_their_own_category() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    let guest = Target::Member(Uuid::new_v4());
    let guest_actions = [
        Action::MemberExpirySet,
        Action::MemberExpired,
        Action::MemberReactivated,
        Action::MemberStandingChanged,
        Action::MemberPurged,
    ];
    for action in guest_actions {
        record(&app.db, space, Some(owner), action, guest, json!({}))
            .await
            .expect("record");
    }
    record(
        &app.db,
        space,
        Some(owner),
        Action::MemberRemoved,
        guest,
        json!({}),
    )
    .await
    .expect("record");
    let cookie = app.cookie_for(owner).await;
    let names = |body: &Value| -> std::collections::BTreeSet<String> {
        body["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .map(|e| e["action"].as_str().expect("action").to_owned())
            .collect()
    };
    let (status, body) = read_log(&app, &cookie, space, "?category=guests").await;
    assert_eq!(status, 200);
    let expected: std::collections::BTreeSet<String> = guest_actions
        .iter()
        .map(|action| action.as_str().to_owned())
        .collect();
    assert_eq!(names(&body), expected);
    assert!(body["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .all(|entry| entry["category"] == "guests"));
    let (_, body) = read_log(&app, &cookie, space, "?category=members").await;
    assert_eq!(
        names(&body),
        ["member.removed".to_owned()].into_iter().collect()
    );
}
