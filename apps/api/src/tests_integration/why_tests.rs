//! "Pourquoi ?": the explanation of a person's access on a channel, a file or a calendar, against
//! a real database. It is the engine's own explain mode, so the result must equal the decision.

use super::*;

use crate::permissions::catalogue::{Family, Permission, PermissionSet};
use crate::permissions::check::{self, Resource};

use super::delegation_tests::make_role;
use super::groups_tests::{give_role_to_group, make_group, put_in_group};
use super::permissions_tests::{join_as, ladder, space_calendar};

async fn exec(db: &DatabaseConnection, sql: &str, values: Vec<sea_orm::Value>) {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .await
    .expect(sql);
}

async fn make_node(
    db: &DatabaseConnection,
    space: Uuid,
    owner: Uuid,
    name: &str,
    kind: &str,
    parent: Option<Uuid>,
) -> Uuid {
    let id = Uuid::new_v4();
    exec(
        db,
        "INSERT INTO files (id, space_id, owner_id, name, kind, parent_folder_id) \
         VALUES ($1, $2, $3, $4, $5, $6)",
        vec![
            id.into(),
            space.into(),
            owner.into(),
            name.into(),
            kind.into(),
            parent.into(),
        ],
    )
    .await;
    id
}

async fn stored(
    db: &DatabaseConnection,
    space: Uuid,
    resource: (&str, Uuid),
    target: (&str, Uuid),
    allow: &[&str],
    deny: &[&str],
) {
    let allow: Vec<String> = allow.iter().map(|p| (*p).to_owned()).collect();
    let deny: Vec<String> = deny.iter().map(|p| (*p).to_owned()).collect();
    exec(
        db,
        &format!(
            "INSERT INTO permission_overrides (space_id, {}, {}, allow, deny) \
             VALUES ($1, $2, $3, $4, $5)",
            resource.0, target.0
        ),
        vec![
            space.into(),
            resource.1.into(),
            target.1.into(),
            allow.into(),
            deny.into(),
        ],
    )
    .await;
}

async fn system_role(db: &DatabaseConnection, space: Uuid, key: &str) -> Uuid {
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT id FROM space_roles WHERE space_id = $1 AND system_key = $2",
        [space.into(), key.into()],
    ))
    .await
    .expect("role")
    .expect("row")
    .try_get("", "id")
    .expect("id")
}

async fn why(
    app: &TestApp,
    asker: Uuid,
    space: Uuid,
    kind: &str,
    resource: Uuid,
    person: Uuid,
) -> (u16, Value) {
    let cookie = app.cookie_for(asker).await;
    let response = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{space}/access/{kind}/{resource}/why?user_id={person}"),
            &cookie,
        )
        .send()
        .await
        .expect("why");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

fn steps(body: &Value) -> &Vec<Value> {
    body["steps"]
        .as_array()
        .unwrap_or_else(|| panic!("steps in {body}"))
}

fn result_of<'a>(body: &'a Value, permission: &str) -> &'a Value {
    body["result"]
        .as_array()
        .unwrap_or_else(|| panic!("result in {body}"))
        .iter()
        .find(|r| r["permission"] == permission)
        .unwrap_or_else(|| panic!("{permission} in {body}"))
}

async fn audit_count(db: &DatabaseConnection, space: Uuid) -> i64 {
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT count(*) AS n FROM space_audit_log WHERE space_id = $1",
        [space.into()],
    ))
    .await
    .expect("count")
    .expect("row")
    .try_get("", "n")
    .expect("n")
}

async fn rule_total(db: &DatabaseConnection, space: Uuid) -> i64 {
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT count(*) AS n FROM permission_overrides WHERE space_id = $1",
        [space.into()],
    ))
    .await
    .expect("count")
    .expect("row")
    .try_get("", "n")
    .expect("n")
}

#[tokio::test]
async fn why_names_the_group_carrying_a_role() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let top = make_node(&app.db, fx.space_id, fx.owner, "Compta", "folder", None).await;
    let folder = make_node(&app.db, fx.space_id, fx.owner, "2026", "folder", Some(top)).await;
    let accountant = make_role(&app.db, fx.space_id, "Comptable", 5, &["files.manage"]).await;
    let comms = make_role(
        &app.db,
        fx.space_id,
        "Communication",
        6,
        &["files.public_link"],
    )
    .await;
    let compta = make_group(&app.db, fx.space_id, "Comptabilite").await;
    let communication = make_group(&app.db, fx.space_id, "Communication").await;
    give_role_to_group(&app.db, compta, fx.space_id, accountant)
        .await
        .expect("carries");
    give_role_to_group(&app.db, communication, fx.space_id, comms)
        .await
        .expect("carries");
    put_in_group(&app.db, compta, fx.space_id, fx.member, false).await;
    put_in_group(&app.db, communication, fx.space_id, fx.member, false).await;

    let (status, body) = why(&app, fx.admin, fx.space_id, "file", folder, fx.member).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["person"]["id"], fx.member.to_string());
    assert_eq!(body["person"]["standing"], "member");
    let base = steps(&body)
        .iter()
        .find(|s| s["kind"] == "base")
        .expect("a base step");
    assert_eq!(base["effect"], "granted");
    for (role, group, permission) in [
        ("Comptable", "Comptabilite", "files.manage"),
        ("Communication", "Communication", "files.public_link"),
    ] {
        let step = steps(&body)
            .iter()
            .find(|s| s["kind"] == "role" && s["role"]["name"] == role)
            .unwrap_or_else(|| panic!("{role} in {body}"));
        assert_eq!(step["permission"], permission);
        assert_eq!(step["role"]["via_group"]["name"], group, "{step}");
    }
    assert_eq!(result_of(&body, "files.manage")["granted"], true);
    // Steps are numbered from one, in order.
    for (i, step) in steps(&body).iter().enumerate() {
        assert_eq!(step["n"], i as u64 + 1);
    }
}

#[tokio::test]
async fn why_agrees_with_the_decision_for_every_permission() {
    let Some(app) = boot().await else { return };
    for round in 0..8u32 {
        let fx = ladder(&app.db).await;
        let top = make_node(&app.db, fx.space_id, fx.owner, "Top", "folder", None).await;
        let file = make_node(&app.db, fx.space_id, fx.member, "f.txt", "file", Some(top)).await;
        let public = make_channel(&app.db, fx.space_id, "salon", "public").await;
        let private = make_channel(&app.db, fx.space_id, "secret", "private").await;
        let calendar = space_calendar(&app.db, fx.space_id, "members").await;
        let group = make_group(&app.db, fx.space_id, "G").await;
        put_in_group(&app.db, group, fx.space_id, fx.member, false).await;
        put_in_group(&app.db, group, fx.space_id, fx.guest, false).await;
        if round % 2 == 0 {
            join_as(&app.db, private, fx.member, "member").await;
        }
        let members = system_role(&app.db, fx.space_id, "members").await;
        let guests = system_role(&app.db, fx.space_id, "guests").await;

        let bytes = *Uuid::new_v4().as_bytes();
        let mut pick = {
            let mut at = 0usize;
            move || {
                let value = bytes[at % 16];
                at += 1;
                value
            }
        };
        let resources: Vec<(&str, &str, Uuid, Family)> = vec![
            ("file_id", "file", top, Family::Files),
            ("file_id", "file", file, Family::Files),
            ("channel_id", "channel", public, Family::Channel),
            ("channel_id", "channel", private, Family::Channel),
            ("calendar_id", "calendar", calendar, Family::Calendar),
        ];
        for (column, _, id, family) in &resources {
            let names: Vec<&str> = PermissionSet::of_family(*family)
                .iter()
                .map(Permission::name)
                .collect();
            for target in [
                ("user_id", fx.member),
                ("user_id", fx.guest),
                ("group_id", group),
                ("role_id", members),
                ("role_id", guests),
            ] {
                if pick() % 3 == 0 {
                    continue;
                }
                let mut allow = Vec::new();
                let mut deny = Vec::new();
                for name in &names {
                    match pick() % 4 {
                        0 => allow.push(*name),
                        1 => deny.push(*name),
                        _ => {}
                    }
                }
                if allow.is_empty() && deny.is_empty() {
                    continue;
                }
                stored(&app.db, fx.space_id, (column, *id), target, &allow, &deny).await;
            }
        }

        for person in [fx.owner, fx.admin, fx.member, fx.guest] {
            for (_, kind, id, family) in &resources {
                let resource = match *kind {
                    "channel" => Resource::Channel(*id),
                    "calendar" => Resource::Calendar(*id),
                    _ => Resource::File(*id),
                };
                let held = check::effective(&app.db, fx.space_id, person, resource)
                    .await
                    .expect("effective");
                let (status, body) = why(&app, fx.owner, fx.space_id, kind, *id, person).await;
                assert_eq!(status, 200, "{body}");
                let listed = body["result"].as_array().expect("result");
                assert_eq!(
                    listed.len(),
                    PermissionSet::of_family(*family).iter().count()
                );
                for permission in PermissionSet::of_family(*family).iter() {
                    assert_eq!(
                        result_of(&body, permission.name())["granted"],
                        held.contains(permission),
                        "{} for {person} on {kind} {id} (round {round}): {body}",
                        permission.name()
                    );
                }
            }
        }
    }
}

#[tokio::test]
async fn why_lists_inherited_levels_in_order() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let top = make_node(&app.db, fx.space_id, fx.owner, "Compta", "folder", None).await;
    let middle = make_node(&app.db, fx.space_id, fx.owner, "2026", "folder", Some(top)).await;
    let file = make_node(
        &app.db,
        fx.space_id,
        fx.owner,
        "bilan",
        "file",
        Some(middle),
    )
    .await;
    let group = make_group(&app.db, fx.space_id, "Comptabilite").await;
    put_in_group(&app.db, group, fx.space_id, fx.member, false).await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", top),
        ("group_id", group),
        &["files.manage"],
        &[],
    )
    .await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", middle),
        ("user_id", fx.member),
        &[],
        &["files.edit"],
    )
    .await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("user_id", fx.member),
        &["files.public_link"],
        &[],
    )
    .await;

    let (status, body) = why(&app, fx.admin, fx.space_id, "file", file, fx.member).await;
    assert_eq!(status, 200, "{body}");
    let rules: Vec<&Value> = steps(&body)
        .iter()
        .filter(|s| s["kind"] == "rule")
        .collect();
    let levels: Vec<&str> = rules
        .iter()
        .map(|s| s["level"]["name"].as_str().expect("level name"))
        .collect();
    assert_eq!(levels, ["Compta", "2026", "bilan"], "{body}");
    assert_eq!(rules[0]["target"]["kind"], "group");
    assert_eq!(rules[0]["target"]["name"], "Comptabilite");
    assert_eq!(rules[0]["effect"], "granted");
    assert_eq!(rules[1]["target"]["kind"], "user");
    assert_eq!(rules[1]["effect"], "removed");
    assert_eq!(rules[1]["permission"], "files.edit");
    assert_eq!(rules[2]["level"]["id"], file.to_string());
    let removal = result_of(&body, "files.edit");
    assert_eq!(removal["granted"], false);
    assert_eq!(removal["reason"]["n"], rules[1]["n"]);
}

#[tokio::test]
async fn why_names_the_private_lock_and_its_lift() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "direction", "private").await;
    let group = make_group(&app.db, fx.space_id, "Direction").await;
    put_in_group(&app.db, group, fx.space_id, fx.member, false).await;

    let (status, body) = why(&app, fx.admin, fx.space_id, "channel", channel, fx.member).await;
    assert_eq!(status, 200, "{body}");
    let lock = steps(&body)
        .iter()
        .find(|s| s["kind"] == "private_lock")
        .expect("the lock");
    assert_eq!(lock["effect"], "removed");
    assert_eq!(lock["permission"], "channel.view");
    assert_eq!(result_of(&body, "channel.view")["granted"], false);
    assert_eq!(result_of(&body, "channel.view")["reason"]["n"], lock["n"]);

    // A group rule opening the channel lifts the lock, and the step says who lifted it.
    stored(
        &app.db,
        fx.space_id,
        ("channel_id", channel),
        ("group_id", group),
        &["channel.view"],
        &[],
    )
    .await;
    let (_, body) = why(&app, fx.admin, fx.space_id, "channel", channel, fx.member).await;
    let lift = steps(&body)
        .iter()
        .find(|s| s["kind"] == "private_lock")
        .expect("the lift");
    assert_eq!(lift["effect"], "granted");
    assert_eq!(lift["target"]["kind"], "group");
    assert_eq!(lift["target"]["name"], "Direction");
    assert_eq!(result_of(&body, "channel.view")["granted"], true);
}

#[tokio::test]
async fn why_names_the_guest_ceiling() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let folder = make_node(&app.db, fx.space_id, fx.owner, "Partage", "folder", None).await;
    let group = make_group(&app.db, fx.space_id, "Externes").await;
    put_in_group(&app.db, group, fx.space_id, fx.guest, false).await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", folder),
        ("group_id", group),
        &["files.view", "files.manage"],
        &[],
    )
    .await;
    // A guest explains themselves.
    let (status, body) = why(&app, fx.guest, fx.space_id, "file", folder, fx.guest).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["person"]["standing"], "guest");
    let ceiling = steps(&body)
        .iter()
        .find(|s| s["kind"] == "guest_ceiling" && s["permission"] == "files.manage")
        .unwrap_or_else(|| panic!("ceiling in {body}"));
    assert_eq!(ceiling["effect"], "removed");
    assert_eq!(result_of(&body, "files.manage")["granted"], false);
    assert_eq!(
        result_of(&body, "files.manage")["reason"]["n"],
        ceiling["n"]
    );
    assert_eq!(result_of(&body, "files.view")["granted"], true);
}

#[tokio::test]
async fn why_for_another_person_needs_members_view() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let folder = make_node(&app.db, fx.space_id, fx.owner, "Partage", "folder", None).await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", folder),
        ("user_id", fx.guest),
        &["files.view"],
        &[],
    )
    .await;
    // A member holds members.view: they may ask about someone else, and about themselves.
    let (status, _) = why(&app, fx.member, fx.space_id, "file", folder, fx.admin).await;
    assert_eq!(status, 200);
    let (status, _) = why(&app, fx.member, fx.space_id, "file", folder, fx.member).await;
    assert_eq!(status, 200);
    // A guest sees the folder, explains themselves, but not anybody else.
    let (status, _) = why(&app, fx.guest, fx.space_id, "file", folder, fx.guest).await;
    assert_eq!(status, 200);
    let (status, _) = why(&app, fx.guest, fx.space_id, "file", folder, fx.member).await;
    assert_eq!(status, 403);
    // Somebody who is not in the space is not a person to explain.
    let outsider = make_user(&app.db, "outsider").await;
    let (status, _) = why(&app, fx.admin, fx.space_id, "file", folder, outsider).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn why_never_reveals_a_resource_the_caller_cannot_see() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let secret = make_channel(&app.db, fx.space_id, "secret", "private").await;
    let (status, _) = why(&app, fx.member, fx.space_id, "channel", secret, fx.member).await;
    assert_eq!(status, 404);
    let (status, _) = why(&app, fx.admin, fx.space_id, "channel", secret, fx.member).await;
    assert_eq!(status, 200);
    // A kind that does not exist, and a resource of nowhere, are not found either.
    let (status, _) = why(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        Uuid::new_v4(),
        fx.member,
    )
    .await;
    assert_eq!(status, 404);

    // A folder the caller cannot open is not named in the steps of a file they can.
    let top = make_node(&app.db, fx.space_id, fx.owner, "Direction", "folder", None).await;
    let file = make_node(
        &app.db,
        fx.space_id,
        fx.owner,
        "paie.txt",
        "file",
        Some(top),
    )
    .await;
    let members = system_role(&app.db, fx.space_id, "members").await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", top),
        ("role_id", members),
        &[],
        &["files.view"],
    )
    .await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("user_id", fx.member),
        &["files.view"],
        &[],
    )
    .await;
    let (status, body) = why(&app, fx.member, fx.space_id, "file", file, fx.member).await;
    assert_eq!(status, 200, "{body}");
    assert!(!body.to_string().contains("Direction"), "{body}");
    assert!(
        steps(&body)
            .iter()
            .any(|s| s["kind"] == "rule" && s["level"]["hidden"] == true),
        "{body}"
    );
    // An audience of a channel they cannot see stays hidden too.
    let other = make_node(&app.db, fx.space_id, fx.owner, "plan.txt", "file", None).await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", other),
        ("audience_channel_id", secret),
        &["files.view"],
        &[],
    )
    .await;
    join_as(&app.db, secret, fx.guest, "member").await;
    let (status, body) = why(&app, fx.member, fx.space_id, "file", other, fx.guest).await;
    assert_eq!(status, 200, "{body}");
    let audience = steps(&body)
        .iter()
        .find(|s| s["target"]["kind"] == "audience")
        .unwrap_or_else(|| panic!("audience step in {body}"));
    assert_eq!(audience["target"]["hidden"], true);
    assert!(!body.to_string().contains("secret"), "{body}");
}

#[tokio::test]
async fn why_is_read_only_and_audits_nothing() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let folder = make_node(&app.db, fx.space_id, fx.owner, "Compta", "folder", None).await;
    let group = make_group(&app.db, fx.space_id, "G").await;
    put_in_group(&app.db, group, fx.space_id, fx.member, false).await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", folder),
        ("group_id", group),
        &["files.edit"],
        &[],
    )
    .await;
    let audits = audit_count(&app.db, fx.space_id).await;
    let rules = rule_total(&app.db, fx.space_id).await;
    let (status, _) = why(&app, fx.admin, fx.space_id, "file", folder, fx.member).await;
    assert_eq!(status, 200);
    assert_eq!(audit_count(&app.db, fx.space_id).await, audits);
    assert_eq!(rule_total(&app.db, fx.space_id).await, rules);
}
