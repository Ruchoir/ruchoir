//! The rule routes the Access and Share dialogs call, against a real database: who may read and
//! edit a resource's access, what each level writes, the legacy bridge of the system roles, the
//! guest filtering, the inherited lines of a file, the refused deletions, and the log.

use super::*;

use futures_util::future::join_all;

use crate::permissions::catalogue::Permission;
use crate::permissions::check::{self, Resource};

use super::delegation_tests::make_role;
use super::edition_tests::{FrozenEdition, LicensedEdition};
use super::groups_tests::{make_group, put_in_group};
use super::permissions_tests::{join_as, ladder, space_calendar, Ladder};

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

/// A rule written straight into the table, aimed at a person (`user_id`), a group (`group_id`) or
/// the readers of a channel (`audience_channel_id`).
async fn stored(
    db: &DatabaseConnection,
    space: Uuid,
    resource: (&str, Uuid),
    target: (&str, Uuid),
    allow: &[&str],
    deny: &[&str],
) -> Uuid {
    let allow: Vec<String> = allow.iter().map(|p| (*p).to_owned()).collect();
    let deny: Vec<String> = deny.iter().map(|p| (*p).to_owned()).collect();
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!(
            "INSERT INTO permission_overrides (space_id, {}, {}, allow, deny) \
             VALUES ($1, $2, $3, $4, $5) RETURNING id",
            resource.0, target.0
        ),
        [
            space.into(),
            resource.1.into(),
            target.1.into(),
            allow.into(),
            deny.into(),
        ],
    ))
    .await
    .expect("rule")
    .expect("row")
    .try_get("", "id")
    .expect("id")
}

async fn call(
    app: &TestApp,
    who: Uuid,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let cookie = app.cookie_for(who).await;
    let mut request = app.req(method, path, &cookie);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.expect("call");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

fn path(space: Uuid, kind: &str, resource: Uuid) -> String {
    format!("/api/v1/spaces/{space}/access/{kind}/{resource}")
}

async fn read(app: &TestApp, who: Uuid, space: Uuid, kind: &str, resource: Uuid) -> (u16, Value) {
    call(
        app,
        who,
        reqwest::Method::GET,
        &path(space, kind, resource),
        None,
    )
    .await
}

async fn put(
    app: &TestApp,
    who: Uuid,
    space: Uuid,
    kind: &str,
    resource: Uuid,
    target: Value,
    level: &str,
) -> (u16, Value) {
    call(
        app,
        who,
        reqwest::Method::PUT,
        &format!("{}/entries", path(space, kind, resource)),
        Some(json!({ "target": target, "level": level })),
    )
    .await
}

async fn remove(
    app: &TestApp,
    who: Uuid,
    space: Uuid,
    kind: &str,
    resource: Uuid,
    rule: Uuid,
) -> (u16, Value) {
    call(
        app,
        who,
        reqwest::Method::DELETE,
        &format!("{}/entries/{rule}", path(space, kind, resource)),
        None,
    )
    .await
}

fn group_target(id: Uuid) -> Value {
    json!({ "kind": "group", "id": id })
}

fn user_target(id: Uuid) -> Value {
    json!({ "kind": "user", "id": id })
}

fn everyone() -> Value {
    json!({ "kind": "everyone" })
}

/// The entry of the dialog aimed at (`kind`, `id`), if any.
fn entry_of<'a>(body: &'a Value, kind: &str, id: Uuid) -> Option<&'a Value> {
    let id = id.to_string();
    body["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .find(|e| e["target"]["kind"] == kind && e["target"]["id"].as_str() == Some(id.as_str()))
}

fn everyone_entry(body: &Value) -> &Value {
    body["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("entries in {body}"))
        .iter()
        .find(|e| e["target"]["kind"] == "everyone" && e["target"]["name"] == "@members")
        .expect("the members line")
}

/// Whether `used_in` names this place (its `level` and `parent_id` are checked elsewhere).
fn names_place(used: &[Value], kind: &str, id: Uuid, name: &str) -> bool {
    used.iter().any(|u| {
        u["kind"] == kind && u["id"] == id.to_string() && u["name"] == name && u["hidden"].is_null()
    })
}

async fn rules_on(
    db: &DatabaseConnection,
    column: &str,
    resource: Uuid,
) -> Vec<(Uuid, Vec<String>, Vec<String>)> {
    db.query_all_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!(
            "SELECT o.id, o.allow, o.deny FROM permission_overrides o \
              LEFT JOIN space_roles r ON r.id = o.role_id \
             WHERE o.{column} = $1 AND r.system_key IS NULL ORDER BY o.created_at, o.id"
        ),
        [resource.into()],
    ))
    .await
    .expect("rules")
    .into_iter()
    .map(|row| {
        (
            row.try_get("", "id").expect("id"),
            row.try_get("", "allow").expect("allow"),
            row.try_get("", "deny").expect("deny"),
        )
    })
    .collect()
}

async fn rule_count(
    db: &DatabaseConnection,
    column: &str,
    resource: Uuid,
    target: (&str, Uuid),
) -> i64 {
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!(
            "SELECT count(*) AS n FROM permission_overrides WHERE {column} = $1 AND {} = $2",
            target.0
        ),
        [resource.into(), target.1.into()],
    ))
    .await
    .expect("count")
    .expect("row")
    .try_get("", "n")
    .expect("n")
}

async fn admitted_roles(db: &DatabaseConnection, channel: Uuid) -> Vec<String> {
    let mut roles: Vec<String> = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT role FROM channel_role_access WHERE channel_id = $1",
            [channel.into()],
        ))
        .await
        .expect("roles")
        .into_iter()
        .map(|row| row.try_get("", "role").expect("role"))
        .collect();
    roles.sort();
    roles
}

async fn write_access(db: &DatabaseConnection, calendar: Uuid) -> String {
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT write_access FROM calendars WHERE id = $1",
        [calendar.into()],
    ))
    .await
    .expect("calendar")
    .expect("row")
    .try_get("", "write_access")
    .expect("write_access")
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

async fn licensed() -> Option<TestApp> {
    boot_as(Arc::new(LicensedEdition), None, |_| {}).await
}

async fn can(app: &TestApp, fx: &Ladder, user: Uuid, resource: Resource, p: Permission) -> bool {
    check::can(&app.db, fx.space_id, user, resource, p)
        .await
        .expect("can")
}

#[tokio::test]
async fn a_space_admin_sets_a_channel_level() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;

    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "contribute",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let entry = entry_of(&body, "group", group).expect("the group line");
    assert_eq!(entry["level"], "contribute");
    assert!(entry["id"].is_string());
    assert_eq!(entry["target"]["name"], "Compta");
    assert_eq!(body["resource"]["kind"], "channel");
    assert_eq!(body["resource"]["name"], "salon");
    assert_eq!(body["private"], false);
    assert_eq!(body["may"]["edit"], true);
    assert_eq!(body["may"]["fine"], false);
    assert!(body["may"]["reason"].is_null());
    let levels = body["may"]["manage_target_levels"]
        .as_array()
        .expect("levels");
    for level in ["none", "read", "contribute", "manage"] {
        assert!(levels.contains(&json!(level)), "{level} in {levels:?}");
    }

    let rows = rules_on(&app.db, "channel_id", channel).await;
    assert_eq!(rows.len(), 1);
    let mut allow = rows[0].1.clone();
    allow.sort();
    let mut expected: Vec<String> = [
        "channel.view",
        "message.react",
        "message.send",
        "message.attach",
        "message.pin",
        "message.mention_all",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    expected.sort();
    assert_eq!(allow, expected);
    assert!(rows[0].2.is_empty(), "a group level only adds");

    // Changing the level rewrites the same rule.
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        entry_of(&body, "group", group).expect("line")["level"],
        "read"
    );
    assert_eq!(rules_on(&app.db, "channel_id", channel).await.len(), 1);
    assert_eq!(
        rules_on(&app.db, "channel_id", channel).await[0].0,
        rows[0].0
    );

    // A plain member reads the dialog but edits nothing.
    let (status, body) = read(&app, fx.member, fx.space_id, "channel", channel).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["may"]["edit"], false);
    assert_eq!(body["may"]["reason"], "not_allowed");
    let (status, _) = put(
        &app,
        fx.member,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "manage",
    )
    .await;
    assert_eq!(status, 403);
    // Someone outside the space reads nothing.
    let stranger = make_user(&app.db, "stranger").await;
    let (status, _) = read(&app, stranger, fx.space_id, "channel", channel).await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn a_channel_moderator_edits_its_channel_access() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let other = make_channel(&app.db, fx.space_id, "autre", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    join_as(&app.db, channel, fx.member, "admin").await;

    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["may"]["edit"], true);
    let levels = body["may"]["manage_target_levels"]
        .as_array()
        .expect("levels");
    assert!(levels.contains(&json!("read")));
    assert!(
        !levels.contains(&json!("none")),
        "the reservation is not theirs"
    );
    let (status, _) = put(
        &app,
        fx.member,
        fx.space_id,
        "channel",
        other,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 403);
    let (status, body) = read(&app, fx.member, fx.space_id, "channel", other).await;
    assert_eq!(status, 200);
    assert_eq!(body["may"]["edit"], false);
}

#[tokio::test]
async fn a_member_with_gerer_on_a_folder_cannot_edit_its_sharing_in_a_free_space() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let folder = make_node(&app.db, fx.space_id, fx.owner, "Compta", "folder", None).await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", folder),
        ("user_id", fx.member),
        &[
            "files.view",
            "files.create",
            "files.edit",
            "files.manage",
            "files.public_link",
        ],
        &[],
    )
    .await;

    let (status, body) = read(&app, fx.member, fx.space_id, "file", folder).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["may"]["edit"], false);
    assert_eq!(body["may"]["reason"], "licence_required");
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "file",
        folder,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 402, "{body}");
    assert_eq!(body["error"], "licence_required");

    // With a licence the same member edits it (local delegation).
    let Some(app) = licensed().await else { return };
    let fx = ladder(&app.db).await;
    let folder = make_node(&app.db, fx.space_id, fx.owner, "Compta", "folder", None).await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", folder),
        ("user_id", fx.member),
        &[
            "files.view",
            "files.create",
            "files.edit",
            "files.manage",
            "files.public_link",
        ],
        &[],
    )
    .await;
    let (status, body) = read(&app, fx.member, fx.space_id, "file", folder).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["may"]["edit"], true);
    assert_eq!(body["may"]["fine"], true);
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "file",
        folder,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn a_file_author_edits_its_sharing() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let mine = make_node(&app.db, fx.space_id, fx.member, "mine.txt", "file", None).await;
    let theirs = make_node(&app.db, fx.space_id, fx.owner, "theirs.txt", "file", None).await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;

    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "file",
        mine,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        entry_of(&body, "group", group).expect("line")["level"],
        "read"
    );
    let (status, _) = put(
        &app,
        fx.member,
        fx.space_id,
        "file",
        theirs,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 403);
    // A folder or file kind in the path must match the row: a file is not a channel.
    let (status, _) = read(&app, fx.member, fx.space_id, "channel", mine).await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn you_cannot_grant_what_you_do_not_hold_here() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    join_as(&app.db, channel, fx.member, "admin").await;
    // The moderator cannot pin here: they cannot hand pinning out.
    stored(
        &app.db,
        fx.space_id,
        ("channel_id", channel),
        ("user_id", fx.member),
        &[],
        &["message.pin"],
    )
    .await;

    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "contribute",
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["reason"], "cannot_grant");
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn a_delegate_cannot_lift_a_rule_aimed_at_them() {
    let Some(app) = licensed().await else { return };
    let fx = ladder(&app.db).await;
    let folder = make_node(&app.db, fx.space_id, fx.owner, "Compta", "folder", None).await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    let own = stored(
        &app.db,
        fx.space_id,
        ("file_id", folder),
        ("user_id", fx.member),
        &[
            "files.view",
            "files.create",
            "files.edit",
            "files.manage",
            "files.public_link",
        ],
        &[],
    )
    .await;

    let (status, body) = remove(&app, fx.member, fx.space_id, "file", folder, own).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["reason"], "target_above_you");
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "file",
        folder,
        user_target(fx.member),
        "read",
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["reason"], "target_above_you");
    assert_eq!(
        rule_count(&app.db, "file_id", folder, ("user_id", fx.member)).await,
        1,
        "the rule aimed at them stays"
    );

    // Their own work is theirs to undo.
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "file",
        folder,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let id: Uuid = entry_of(&body, "group", group).expect("line")["id"]
        .as_str()
        .expect("id")
        .parse()
        .expect("uuid");
    let (status, _) = remove(&app, fx.member, fx.space_id, "file", folder, id).await;
    assert_eq!(status, 204);
    // And an administrator lifts it.
    let (status, _) = remove(&app, fx.admin, fx.space_id, "file", folder, own).await;
    assert_eq!(status, 204);
}

#[tokio::test]
async fn manage_is_refused_for_a_guest_target() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let file = make_node(&app.db, fx.space_id, fx.owner, "plan.txt", "file", None).await;
    let guests = system_role(&app.db, fx.space_id, "guests").await;

    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "file",
        file,
        user_target(fx.guest),
        "manage",
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "guest_ceiling");
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "file",
        file,
        json!({ "kind": "everyone", "id": guests }),
        "manage",
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "guest_ceiling");
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "file",
        file,
        user_target(fx.guest),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let entry = entry_of(&body, "user", fx.guest).expect("line");
    assert_eq!(entry["guest"], true);
    assert_eq!(entry["level"], "read");
}

#[tokio::test]
async fn a_group_level_is_clamped_for_its_guests() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    put_in_group(&app.db, group, fx.space_id, fx.guest, false).await;
    put_in_group(&app.db, group, fx.space_id, fx.member, false).await;

    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "manage",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let entry = entry_of(&body, "group", group).expect("line");
    assert_eq!(entry["level"], "manage");
    assert_eq!(entry["clamped"], true);
    let channel_ref = Resource::Channel(channel);
    assert!(can(&app, &fx, fx.member, channel_ref, Permission::ChannelManage).await);
    assert!(!can(&app, &fx, fx.guest, channel_ref, Permission::ChannelManage).await);
    // A level inside the ceiling is not clamped.
    let (_, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "contribute",
    )
    .await;
    assert_eq!(
        entry_of(&body, "group", group).expect("line")["clamped"],
        false
    );
}

#[tokio::test]
async fn a_guest_sees_only_the_entries_that_cover_them() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let mine = make_group(&app.db, fx.space_id, "Mon groupe").await;
    let theirs = make_group(&app.db, fx.space_id, "Autre groupe").await;
    put_in_group(&app.db, mine, fx.space_id, fx.guest, false).await;
    let guests = system_role(&app.db, fx.space_id, "guests").await;
    for (kind, id) in [
        ("group_id", mine),
        ("group_id", theirs),
        ("user_id", fx.guest),
        ("user_id", fx.member),
    ] {
        stored(
            &app.db,
            fx.space_id,
            ("channel_id", channel),
            (kind, id),
            &["channel.view"],
            &[],
        )
        .await;
    }
    stored(
        &app.db,
        fx.space_id,
        ("channel_id", channel),
        ("role_id", guests),
        &["message.react"],
        &[],
    )
    .await;

    let (status, body) = read(&app, fx.guest, fx.space_id, "channel", channel).await;
    assert_eq!(status, 200, "{body}");
    assert!(entry_of(&body, "group", mine).is_some());
    assert!(entry_of(&body, "user", fx.guest).is_some());
    assert!(entry_of(&body, "everyone", guests).is_some());
    assert!(entry_of(&body, "group", theirs).is_none(), "{body}");
    assert!(entry_of(&body, "user", fx.member).is_none());
    assert!(
        body["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .all(|e| e["target"]["name"] != "@members" && e["target"]["name"] != "Administrator"),
        "{body}"
    );
    assert_eq!(body["may"]["edit"], false);

    // The administrator sees all of them.
    let (_, body) = read(&app, fx.admin, fx.space_id, "channel", channel).await;
    assert!(entry_of(&body, "group", theirs).is_some());
    assert!(entry_of(&body, "user", fx.member).is_some());
}

#[tokio::test]
async fn an_audience_entry_hides_a_channel_the_viewer_cannot_see() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let secret = make_channel(&app.db, fx.space_id, "secret", "private").await;
    let file = make_node(&app.db, fx.space_id, fx.owner, "plan.txt", "file", None).await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("audience_channel_id", secret),
        &["files.view"],
        &[],
    )
    .await;

    let (status, body) = read(&app, fx.member, fx.space_id, "file", file).await;
    assert_eq!(status, 200, "{body}");
    let line = body["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .find(|e| e["target"]["kind"] == "audience")
        .expect("the audience line");
    assert_eq!(line["target"]["hidden"], true);
    assert!(
        line["target"].get("name").is_none_or(Value::is_null),
        "{line}"
    );
    assert!(
        line["target"].get("id").is_none_or(Value::is_null),
        "{line}"
    );
    assert_eq!(line["level"], "read");

    // Once they read that channel the line names it.
    join_as(&app.db, secret, fx.member, "member").await;
    let (_, body) = read(&app, fx.member, fx.space_id, "file", file).await;
    let line = entry_of(&body, "audience", secret).expect("named now");
    assert_eq!(line["target"]["name"], "secret");
    assert!(line["target"].get("hidden").is_none_or(|h| *h == false));

    // Only files take an audience.
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        json!({ "kind": "audience", "id": channel }),
        "read",
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "audience_files_only");
}

#[tokio::test]
async fn inherited_entries_name_their_folder() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let top = make_node(&app.db, fx.space_id, fx.owner, "Compta", "folder", None).await;
    let middle = make_node(&app.db, fx.space_id, fx.owner, "2026", "folder", Some(top)).await;
    let file = make_node(
        &app.db,
        fx.space_id,
        fx.owner,
        "bilan.xlsx",
        "file",
        Some(middle),
    )
    .await;
    let g = make_group(&app.db, fx.space_id, "G").await;
    let h = make_group(&app.db, fx.space_id, "H").await;
    let j = make_group(&app.db, fx.space_id, "J").await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", top),
        ("group_id", g),
        &["files.view"],
        &[],
    )
    .await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", top),
        ("group_id", j),
        &["files.view"],
        &[],
    )
    .await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", middle),
        ("group_id", h),
        &["files.view"],
        &[],
    )
    .await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("group_id", g),
        &["files.view", "files.create", "files.edit"],
        &[],
    )
    .await;

    let (status, body) = read(&app, fx.admin, fx.space_id, "file", file).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["resource"]["parent"]["id"], middle.to_string());
    assert_eq!(body["resource"]["parent"]["name"], "2026");
    let own = entry_of(&body, "group", g).expect("own G");
    assert_eq!(own["level"], "contribute");
    assert!(own["id"].is_string());
    assert!(own.get("inherited_from").is_none_or(Value::is_null));
    let from_middle = entry_of(&body, "group", h).expect("inherited H");
    assert!(from_middle["id"].is_null());
    assert_eq!(from_middle["inherited_from"]["id"], middle.to_string());
    assert_eq!(from_middle["inherited_from"]["name"], "2026");
    assert_eq!(from_middle["level"], "read");
    let from_top = entry_of(&body, "group", j).expect("inherited J");
    assert!(from_top["id"].is_null());
    assert_eq!(from_top["inherited_from"]["id"], top.to_string());
    assert_eq!(from_top["inherited_from"]["name"], "Compta");
    let g_lines = body["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .filter(|e| e["target"]["id"] == g.to_string())
        .count();
    assert_eq!(g_lines, 1, "the override replaces the inherited line");

    // Setting H on the file overrides the folder's line.
    let (_, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "file",
        file,
        group_target(h),
        "contribute",
    )
    .await;
    let line = entry_of(&body, "group", h).expect("H");
    assert!(line["id"].is_string());
    assert!(line.get("inherited_from").is_none_or(Value::is_null));
    assert_eq!(line["level"], "contribute");
    // The folder itself lists none of its children's.
    let (_, body) = read(&app, fx.admin, fx.space_id, "file", top).await;
    assert!(entry_of(&body, "group", h).is_none());
}

#[tokio::test]
async fn a_group_named_by_a_rule_is_not_deleted() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let file = make_node(&app.db, fx.space_id, fx.owner, "plan.txt", "file", None).await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let (status, _) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 200);
    let (_, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "file",
        file,
        group_target(group),
        "read",
    )
    .await;
    let file_rule: Uuid = entry_of(&body, "group", group).expect("line")["id"]
        .as_str()
        .expect("id")
        .parse()
        .expect("uuid");

    let url = format!("/api/v1/spaces/{}/groups/{group}", fx.space_id);
    let (status, body) = call(&app, fx.admin, reqwest::Method::DELETE, &url, None).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"], "group_has_rules");
    let used = body["used_in"].as_array().expect("used_in");
    assert_eq!(used.len(), 2, "{body}");
    assert!(names_place(used, "channel", channel, "salon"));
    assert!(names_place(used, "file", file, "plan.txt"));

    // Nothing was removed; once the rules go the group goes.
    assert_eq!(
        rule_count(&app.db, "channel_id", channel, ("group_id", group)).await,
        1
    );
    let rule = rules_on(&app.db, "channel_id", channel).await[0].0;
    assert_eq!(
        remove(&app, fx.admin, fx.space_id, "channel", channel, rule)
            .await
            .0,
        204
    );
    assert_eq!(
        remove(&app, fx.admin, fx.space_id, "file", file, file_rule)
            .await
            .0,
        204
    );
    let (status, _) = call(&app, fx.admin, reqwest::Method::DELETE, &url, None).await;
    assert_eq!(status, 204);
}

#[tokio::test]
async fn tout_l_espace_aucun_acces_is_the_reservation() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let (status, _) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "contribute",
    )
    .await;
    assert_eq!(status, 200);
    assert!(
        can(
            &app,
            &fx,
            fx.member,
            Resource::Channel(channel),
            Permission::ChannelView
        )
        .await
    );

    // "Aucun accès" for everyone reserves the channel, the legacy way.
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "none",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let line = everyone_entry(&body);
    assert_eq!(line["level"], "none");
    assert_eq!(line["via_legacy"], true);
    let roles = admitted_roles(&app.db, channel).await;
    assert!(!roles.contains(&"member".to_owned()), "{roles:?}");
    assert!(roles.contains(&"admin".to_owned()));
    assert!(
        !can(
            &app,
            &fx,
            fx.member,
            Resource::Channel(channel),
            Permission::ChannelView
        )
        .await
    );

    // A later legacy write of the roles does not erase the group's rule, and the dialog follows.
    let (status, _) = call(
        &app,
        fx.admin,
        reqwest::Method::PATCH,
        &format!("/api/v1/channels/{channel}"),
        Some(json!({ "allowed_roles": ["admin", "member"] })),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        rule_count(&app.db, "channel_id", channel, ("group_id", group)).await,
        1
    );
    let (_, body) = read(&app, fx.admin, fx.space_id, "channel", channel).await;
    assert_ne!(everyone_entry(&body)["level"], "none");
    assert!(entry_of(&body, "group", group).is_some());
    assert!(
        can(
            &app,
            &fx,
            fx.member,
            Resource::Channel(channel),
            Permission::ChannelView
        )
        .await
    );
    let (status, _) = call(
        &app,
        fx.admin,
        reqwest::Method::PATCH,
        &format!("/api/v1/channels/{channel}"),
        Some(json!({ "allowed_roles": ["admin"] })),
    )
    .await;
    assert_eq!(status, 200);
    let (_, body) = read(&app, fx.admin, fx.space_id, "channel", channel).await;
    assert_eq!(everyone_entry(&body)["level"], "none");
    assert_eq!(
        rule_count(&app.db, "channel_id", channel, ("group_id", group)).await,
        1
    );

    // A level for everyone brings the role back.
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(everyone_entry(&body)["level"], "read");
    assert!(admitted_roles(&app.db, channel)
        .await
        .contains(&"member".to_owned()));
    assert!(
        can(
            &app,
            &fx,
            fx.member,
            Resource::Channel(channel),
            Permission::ChannelView
        )
        .await
    );
    assert!(
        !can(
            &app,
            &fx,
            fx.member,
            Resource::Channel(channel),
            Permission::MessageSend
        )
        .await
    );
    // Back to Participer, the sends come back; the group's rule is still there. The administrator
    // does it too: lowering everyone took nothing from the means to raise it again.
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "contribute",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(everyone_entry(&body)["level"], "contribute");
    assert!(
        can(
            &app,
            &fx,
            fx.member,
            Resource::Channel(channel),
            Permission::MessageSend
        )
        .await
    );
    assert!(entry_of(&body, "group", group).is_some());
}

#[tokio::test]
async fn the_reservation_stays_with_administrators() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    join_as(&app.db, channel, fx.member, "admin").await;
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "none",
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["reason"], "reservation_admins_only");
    assert!(admitted_roles(&app.db, channel).await.is_empty());
    // Lire stays open to the moderator, and it is a real change for everyone.
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(everyone_entry(&body)["level"], "read");
}

#[tokio::test]
async fn a_calendar_ecrire_for_everyone_is_write_access_members() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let calendar = space_calendar(&app.db, fx.space_id, "admins").await;
    let resource = Resource::Calendar(calendar);
    assert!(!can(&app, &fx, fx.member, resource, Permission::CalendarWrite).await);

    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "calendar",
        calendar,
        everyone(),
        "contribute",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(write_access(&app.db, calendar).await, "members");
    assert_eq!(everyone_entry(&body)["level"], "contribute");
    assert_eq!(everyone_entry(&body)["via_legacy"], true);
    assert!(can(&app, &fx, fx.member, resource, Permission::CalendarWrite).await);

    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "calendar",
        calendar,
        everyone(),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(write_access(&app.db, calendar).await, "admins");
    assert_eq!(everyone_entry(&body)["level"], "read");
    assert!(!can(&app, &fx, fx.member, resource, Permission::CalendarWrite).await);
    assert!(can(&app, &fx, fx.member, resource, Permission::CalendarView).await);
    assert!(can(&app, &fx, fx.admin, resource, Permission::CalendarWrite).await);

    // The legacy setting read back: a calendar closed the old way reads "Lire" in the dialog.
    exec(
        &app.db,
        "UPDATE calendars SET write_access = 'members' WHERE id = $1",
        vec![calendar.into()],
    )
    .await;
    let (_, body) = read(&app, fx.admin, fx.space_id, "calendar", calendar).await;
    assert_eq!(everyone_entry(&body)["level"], "contribute");
}

#[tokio::test]
async fn custom_rules_need_a_licence() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let role = make_role(&app.db, fx.space_id, "Comptable", 20, &["files.view"]).await;

    // A deny for a group is a fine rule: paid.
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "none",
    )
    .await;
    assert_eq!(status, 402, "{body}");
    assert_eq!(body["error"], "licence_required");
    // So is a custom role as a target.
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        json!({ "kind": "role", "id": role }),
        "read",
    )
    .await;
    assert_eq!(status, 402, "{body}");
    assert!(rules_on(&app.db, "channel_id", channel).await.is_empty());
    let (_, body) = read(&app, fx.admin, fx.space_id, "channel", channel).await;
    assert_eq!(body["may"]["fine"], false);

    let Some(frozen) = boot_as(Arc::new(FrozenEdition), None, |_| {}).await else {
        return;
    };
    let ffx = ladder(&frozen.db).await;
    let fchannel = make_channel(&frozen.db, ffx.space_id, "salon", "public").await;
    let fgroup = make_group(&frozen.db, ffx.space_id, "Compta").await;
    let (status, body) = put(
        &frozen,
        ffx.admin,
        ffx.space_id,
        "channel",
        fchannel,
        group_target(fgroup),
        "none",
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"], "licence_frozen");
    // A free level still goes through in a frozen space.
    let (status, _) = put(
        &frozen,
        ffx.admin,
        ffx.space_id,
        "channel",
        fchannel,
        group_target(fgroup),
        "read",
    )
    .await;
    assert_eq!(status, 200);

    let Some(paid) = licensed().await else { return };
    let pfx = ladder(&paid.db).await;
    let pchannel = make_channel(&paid.db, pfx.space_id, "salon", "public").await;
    let pgroup = make_group(&paid.db, pfx.space_id, "Compta").await;
    let prole = make_role(&paid.db, pfx.space_id, "Comptable", 20, &["files.view"]).await;
    let (status, body) = put(
        &paid,
        pfx.admin,
        pfx.space_id,
        "channel",
        pchannel,
        group_target(pgroup),
        "none",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let line = entry_of(&body, "group", pgroup).expect("line");
    assert_eq!(line["level"], "custom");
    assert_eq!(line["deny"], json!(["channel.view"]));
    assert!(line["summary"].is_object() || line["summary"].is_array());
    assert_eq!(body["may"]["fine"], true);
    let (status, body) = put(
        &paid,
        pfx.admin,
        pfx.space_id,
        "channel",
        pchannel,
        json!({ "kind": "role", "id": prole }),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn targets_outside_the_space_are_refused() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let other = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let foreign_group = make_group(&app.db, other.space_id, "Ailleurs").await;
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(foreign_group),
        "read",
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "not_in_space");
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        user_target(other.member),
        "read",
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "not_in_space");
    // A resource of another space is nothing here.
    let (status, _) = read(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        make_channel(&app.db, other.space_id, "ailleurs", "public").await,
    )
    .await;
    assert_eq!(status, 403);
    let (status, _) = read(&app, fx.admin, fx.space_id, "folder", channel).await;
    assert_eq!(status, 404);
}

async fn audit_rows(db: &DatabaseConnection, space: Uuid) -> Vec<(String, Value)> {
    db.query_all_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT action, details FROM space_audit_log \
          WHERE space_id = $1 AND action LIKE 'rule.%' ORDER BY at, id",
        [space.into()],
    ))
    .await
    .expect("audit")
    .into_iter()
    .map(|row| {
        (
            row.try_get("", "action").expect("action"),
            row.try_get("", "details").expect("details"),
        )
    })
    .collect()
}

#[tokio::test]
async fn every_rule_write_is_logged_and_announced() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let mut watching = app.connect_ws(&app.cookie_for(fx.member).await).await;

    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "contribute",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    super::group_routes_tests::expect_permissions_changed(&mut watching, fx.space_id).await;
    // The same level again changes nothing: no entry, no event.
    let (status, _) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "contribute",
    )
    .await;
    assert_eq!(status, 200);
    super::group_routes_tests::expect_no_permissions_changed(&mut watching).await;
    assert_eq!(audit_rows(&app.db, fx.space_id).await.len(), 1);

    let (_, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "read",
    )
    .await;
    let rule: Uuid = entry_of(&body, "group", group).expect("line")["id"]
        .as_str()
        .expect("id")
        .parse()
        .expect("uuid");
    super::group_routes_tests::expect_permissions_changed(&mut watching, fx.space_id).await;
    let (status, _) = remove(&app, fx.admin, fx.space_id, "channel", channel, rule).await;
    assert_eq!(status, 204);
    super::group_routes_tests::expect_permissions_changed(&mut watching, fx.space_id).await;

    let log = audit_rows(&app.db, fx.space_id).await;
    let actions: Vec<&str> = log.iter().map(|(a, _)| a.as_str()).collect();
    assert_eq!(actions, ["rule.created", "rule.updated", "rule.deleted"]);
    assert_eq!(log[0].1["target_kind"], "group");
    assert_eq!(log[0].1["target_id"], group.to_string());
    assert!(log[0].1["before"].is_null());
    assert_eq!(log[0].1["after"], "contribute");
    assert_eq!(log[1].1["before"], "contribute");
    assert_eq!(log[1].1["after"], "read");
    assert_eq!(log[2].1["before"], "read");
    assert!(log[2].1["after"].is_null());

    let (status, page) = call(
        &app,
        fx.owner,
        reqwest::Method::GET,
        &format!("/api/v1/spaces/{}/audit?category=access", fx.space_id),
        None,
    )
    .await;
    assert_eq!(status, 200, "{page}");
    let entries = page["entries"].as_array().expect("entries");
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0]["action"], "rule.deleted");
    assert_eq!(entries[0]["category"], "access");
    assert_eq!(entries[0]["target"]["kind"], "channel");
    assert_eq!(entries[0]["target"]["label"], "salon");
}

#[tokio::test]
async fn concurrent_rule_writes_on_one_resource_keep_one_row() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let levels = [
        "read",
        "contribute",
        "manage",
        "read",
        "contribute",
        "manage",
        "read",
        "contribute",
    ];
    let writes = levels.iter().map(|level| {
        put(
            &app,
            fx.admin,
            fx.space_id,
            "channel",
            channel,
            group_target(group),
            level,
        )
    });
    for (status, body) in join_all(writes).await {
        assert_eq!(status, 200, "{body}");
    }
    let rows = rules_on(&app.db, "channel_id", channel).await;
    assert_eq!(rows.len(), 1, "one rule per resource and target");
    // The log agrees with the table: one creation, the rest updates (or nothing when equal).
    let log = audit_rows(&app.db, fx.space_id).await;
    assert_eq!(log.iter().filter(|(a, _)| a == "rule.created").count(), 1);
}

#[tokio::test]
async fn deleting_a_missing_rule_is_a_not_found() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let other = make_channel(&app.db, fx.space_id, "autre", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let (_, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        other,
        group_target(group),
        "read",
    )
    .await;
    let rule: Uuid = entry_of(&body, "group", group).expect("line")["id"]
        .as_str()
        .expect("id")
        .parse()
        .expect("uuid");
    // The rule of another resource is not this one's to delete.
    let (status, _) = remove(&app, fx.admin, fx.space_id, "channel", channel, rule).await;
    assert_eq!(status, 404);
    let (status, _) = remove(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(rules_on(&app.db, "channel_id", other).await.len(), 1);
}

async fn members_rows(db: &DatabaseConnection, channel: Uuid) -> Vec<(Vec<String>, Vec<String>)> {
    db.query_all_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT o.allow, o.deny FROM permission_overrides o JOIN space_roles r ON r.id = o.role_id \
          WHERE o.channel_id = $1 AND r.system_key = 'members'",
        [channel.into()],
    ))
    .await
    .expect("rows")
    .into_iter()
    .map(|row| (row.try_get("", "allow").expect("allow"), row.try_get("", "deny").expect("deny")))
    .collect()
}

#[tokio::test]
async fn a_plain_admin_lowers_everyone_and_raises_it_back() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let calendar = space_calendar(&app.db, fx.space_id, "members").await;
    for (kind, id, low, high) in [
        ("channel", channel, "read", "contribute"),
        ("calendar", calendar, "read", "contribute"),
    ] {
        let (status, body) = put(&app, fx.admin, fx.space_id, kind, id, everyone(), low).await;
        assert_eq!(status, 200, "{body}");
        let levels = body["may"]["manage_target_levels"]
            .as_array()
            .expect("levels");
        assert!(levels.contains(&json!("manage")), "{kind}: {levels:?}");
        let (status, body) = put(&app, fx.admin, fx.space_id, kind, id, everyone(), high).await;
        assert_eq!(status, 200, "{kind}: {body}");
        assert_eq!(everyone_entry(&body)["level"], high);
    }
}

#[tokio::test]
async fn administrators_keep_gerer_when_everyone_is_lowered() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let calendar = space_calendar(&app.db, fx.space_id, "members").await;
    let admin_role = system_role(&app.db, fx.space_id, "administrator").await;

    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let line = entry_of(&body, "role", admin_role).expect("the administrator line");
    assert_eq!(line["level"], "manage");
    assert!(line["id"].is_string(), "{line}");
    let channel_ref = Resource::Channel(channel);
    assert!(can(&app, &fx, fx.admin, channel_ref, Permission::MessageManage).await);
    assert!(can(&app, &fx, fx.admin, channel_ref, Permission::ChannelManage).await);
    assert!(!can(&app, &fx, fx.member, channel_ref, Permission::MessageSend).await);
    // Both writes are in the log.
    let log = audit_rows(&app.db, fx.space_id).await;
    let kinds: Vec<(&str, &str)> = log
        .iter()
        .map(|(a, d)| (a.as_str(), d["target_kind"].as_str().expect("kind")))
        .collect();
    assert_eq!(
        kinds,
        [("rule.created", "everyone"), ("rule.created", "role")]
    );
    assert_eq!(log[1].1["after"], "manage");

    // The same on a calendar.
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "calendar",
        calendar,
        everyone(),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        entry_of(&body, "role", admin_role).expect("line")["level"],
        "manage"
    );
    assert!(
        can(
            &app,
            &fx,
            fx.admin,
            Resource::Calendar(calendar),
            Permission::CalendarManage
        )
        .await
    );

    // An Administrator rule that already speaks is left alone.
    let other = make_channel(&app.db, fx.space_id, "autre", "public").await;
    stored(
        &app.db,
        fx.space_id,
        ("channel_id", other),
        ("role_id", admin_role),
        &["message.react"],
        &[],
    )
    .await;
    let (status, _) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        other,
        everyone(),
        "read",
    )
    .await;
    assert_eq!(status, 200);
    let rows = db_rows(&app.db, other, admin_role).await;
    assert_eq!(rows, vec![vec!["message.react".to_owned()]]);
    // Gérer for everyone writes no Administrator line.
    let third = make_channel(&app.db, fx.space_id, "troisieme", "public").await;
    let (_, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        third,
        everyone(),
        "manage",
    )
    .await;
    assert!(
        db_rows(&app.db, third, admin_role).await.is_empty(),
        "{body}"
    );
}

async fn db_rows(db: &DatabaseConnection, channel: Uuid, role: Uuid) -> Vec<Vec<String>> {
    db.query_all_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT allow FROM permission_overrides WHERE channel_id = $1 AND role_id = $2",
        [channel.into(), role.into()],
    ))
    .await
    .expect("rows")
    .into_iter()
    .map(|row| row.try_get("", "allow").expect("allow"))
    .collect()
}

#[tokio::test]
async fn reserving_a_channel_tells_the_sidebars() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let mut watching = app.connect_ws(&app.cookie_for(fx.owner).await).await;
    // A rule that does not touch the view bit says nothing to the sidebars.
    let (status, _) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 200);
    super::group_routes_tests::expect_permissions_changed(&mut watching, fx.space_id).await;
    let (status, _) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "none",
    )
    .await;
    assert_eq!(status, 200);
    let event = wait_for_type(&mut watching, "channel.updated").await;
    assert_eq!(event["payload"]["id"], channel.to_string());
    // And the removal of that line does too.
    let (_, body) = read(&app, fx.admin, fx.space_id, "channel", channel).await;
    let line = everyone_entry(&body);
    let rule: Uuid = line["id"]
        .as_str()
        .expect("the stored line")
        .parse()
        .expect("uuid");
    let (status, _) = remove(&app, fx.admin, fx.space_id, "channel", channel, rule).await;
    assert_eq!(status, 204);
    wait_for_type(&mut watching, "channel.updated").await;
}

#[tokio::test]
async fn a_group_is_clamped_only_when_it_holds_guests() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let plain = make_group(&app.db, fx.space_id, "Equipe").await;
    let mixed = make_group(&app.db, fx.space_id, "Equipe mixte").await;
    put_in_group(&app.db, plain, fx.space_id, fx.member, false).await;
    put_in_group(&app.db, mixed, fx.space_id, fx.guest, false).await;
    put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(plain),
        "manage",
    )
    .await;
    let (_, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(mixed),
        "manage",
    )
    .await;
    assert_eq!(
        entry_of(&body, "group", plain).expect("plain")["clamped"],
        false
    );
    assert_eq!(
        entry_of(&body, "group", mixed).expect("mixed")["clamped"],
        true
    );
}

#[tokio::test]
async fn nothing_is_stored_for_a_level_the_legacy_setting_carries_alone() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let (status, _) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "read",
    )
    .await;
    assert_eq!(status, 200);
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "none",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    // Only the reservation's own deny of the view remains: no leftover allow of the old level.
    assert_eq!(
        members_rows(&app.db, channel).await,
        vec![(vec![], vec!["channel.view".to_owned()])]
    );
    let log = audit_rows(&app.db, fx.space_id).await;
    assert_eq!(log.len(), 3, "{log:?}");
    assert_eq!(log[2].0, "rule.updated");
    assert_eq!(log[2].1["before"], "read");
    assert_eq!(log[2].1["after"], "none");
}

#[tokio::test]
async fn a_folder_the_viewer_cannot_open_is_not_named() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let folder = make_node(&app.db, fx.space_id, fx.owner, "Direction", "folder", None).await;
    let file = make_node(
        &app.db,
        fx.space_id,
        fx.owner,
        "plan.txt",
        "file",
        Some(folder),
    )
    .await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", folder),
        ("group_id", group),
        &["files.view"],
        &[],
    )
    .await;
    // The member cannot open the folder but was shared the file.
    stored(
        &app.db,
        fx.space_id,
        ("file_id", folder),
        ("user_id", fx.member),
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

    let (status, body) = read(&app, fx.member, fx.space_id, "file", file).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["resource"]["parent"]["hidden"], true);
    assert!(body["resource"]["parent"].get("name").is_none(), "{body}");
    let line = entry_of(&body, "group", group).expect("inherited line");
    assert_eq!(line["inherited_from"]["hidden"], true);
    assert!(line["inherited_from"].get("id").is_none());
    assert!(line["inherited_from"].get("name").is_none());
    // Whoever can open the folder sees its name.
    let (_, body) = read(&app, fx.admin, fx.space_id, "file", file).await;
    assert_eq!(
        entry_of(&body, "group", group).expect("line")["inherited_from"]["name"],
        "Direction"
    );
}

#[tokio::test]
async fn a_repeated_everyone_write_writes_nothing_and_says_nothing() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    // The base already reads Participer: asking for it again is a no-op, whatever the Administrator line.
    let mut watching = app.connect_ws(&app.cookie_for(fx.member).await).await;
    let (status, _) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "contribute",
    )
    .await;
    assert_eq!(status, 200);
    super::group_routes_tests::expect_no_permissions_changed(&mut watching).await;
    assert!(audit_rows(&app.db, fx.space_id).await.is_empty());
    let admin_role = system_role(&app.db, fx.space_id, "administrator").await;
    assert!(db_rows(&app.db, channel, admin_role).await.is_empty());
    // A real change writes both lines once; repeating it adds nothing.
    put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "read",
    )
    .await;
    super::group_routes_tests::expect_permissions_changed(&mut watching, fx.space_id).await;
    let written = audit_rows(&app.db, fx.space_id).await.len();
    assert_eq!(written, 2);
    put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "read",
    )
    .await;
    super::group_routes_tests::expect_no_permissions_changed(&mut watching).await;
    assert_eq!(audit_rows(&app.db, fx.space_id).await.len(), written);
}

// -- security review fixes ----------------------------------------------------------------------

fn id_of(entry: &Value) -> Uuid {
    entry["id"].as_str().expect("id").parse().expect("uuid")
}

#[tokio::test]
async fn lifting_a_restriction_needs_what_it_restores() {
    let Some(app) = licensed().await else { return };
    let fx = ladder(&app.db).await;

    // A channel moderator cannot undo "Tout l'espace = Lire": it restores sending for everyone.
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    join_as(&app.db, channel, fx.member, "admin").await;
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let line = id_of(everyone_entry(&body));
    let (status, body) = remove(&app, fx.member, fx.space_id, "channel", channel, line).await;
    assert_eq!((status, &body["reason"]), (403, &json!("cannot_grant")));
    // Lowering the deny is lifting it too.
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "channel",
        channel,
        everyone(),
        "contribute",
    )
    .await;
    assert_eq!((status, &body["reason"]), (403, &json!("cannot_grant")));
    let (status, body) = read(&app, fx.admin, fx.space_id, "channel", channel).await;
    assert_eq!(status, 200);
    assert_eq!(everyone_entry(&body)["level"], "read", "still Lire");
    let (status, _) = remove(&app, fx.admin, fx.space_id, "channel", channel, line).await;
    assert_eq!(status, 204, "a space administrator holds what it restores");

    // The author of a file, the same.
    let mine = make_node(&app.db, fx.space_id, fx.member, "mine.txt", "file", None).await;
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "file",
        mine,
        everyone(),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let line = id_of(everyone_entry(&body));
    let (status, body) = remove(&app, fx.member, fx.space_id, "file", mine, line).await;
    assert_eq!((status, &body["reason"]), (403, &json!("cannot_grant")));
    let (status, _) = remove(&app, fx.admin, fx.space_id, "file", mine, line).await;
    assert_eq!(status, 204);

    // A local editor (a paid delegation), for any target.
    let theirs = make_node(&app.db, fx.space_id, fx.owner, "theirs.txt", "file", None).await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", theirs),
        ("user_id", fx.member),
        &["files.view", "files.manage"],
        &[],
    )
    .await;
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "file",
        theirs,
        everyone(),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let line = id_of(everyone_entry(&body));
    let (status, body) = remove(&app, fx.member, fx.space_id, "file", theirs, line).await;
    assert_eq!((status, &body["reason"]), (403, &json!("cannot_grant")));
    let blocked = stored(
        &app.db,
        fx.space_id,
        ("file_id", theirs),
        ("group_id", group),
        &["files.view"],
        &["files.edit"],
    )
    .await;
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "file",
        theirs,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!((status, &body["reason"]), (403, &json!("cannot_grant")));
    let (status, body) = remove(&app, fx.member, fx.space_id, "file", theirs, blocked).await;
    assert_eq!((status, &body["reason"]), (403, &json!("cannot_grant")));
    let (status, _) = remove(&app, fx.admin, fx.space_id, "file", theirs, blocked).await;
    assert_eq!(status, 204);
}

#[tokio::test]
async fn a_guest_author_is_no_editor() {
    let Some(app) = licensed().await else { return };
    let fx = ladder(&app.db).await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    // A guest's own upload, in reach of the guest (a person rule opens it).
    let file = make_node(&app.db, fx.space_id, fx.guest, "invite.txt", "file", None).await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("user_id", fx.guest),
        &["files.view"],
        &[],
    )
    .await;
    let (status, body) = read(&app, fx.guest, fx.space_id, "file", file).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["may"]["edit"], false);
    assert_eq!(body["may"]["reason"], "not_allowed");
    let (status, _) = put(
        &app,
        fx.guest,
        fx.space_id,
        "file",
        file,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(
        rule_count(&app.db, "file_id", file, ("group_id", group)).await,
        0
    );
}

#[tokio::test]
async fn an_administrator_does_not_open_a_private_channel_they_are_not_in() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let secret = make_channel(&app.db, fx.space_id, "secret", "private").await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    let why = format!("{}/why", path(fx.space_id, "channel", secret));
    let someone = stored(
        &app.db,
        fx.space_id,
        ("channel_id", secret),
        ("group_id", group),
        &["channel.view"],
        &[],
    )
    .await;

    // The administrator is a stranger to it, whatever they write.
    assert_eq!(
        read(&app, fx.admin, fx.space_id, "channel", secret).await.0,
        403
    );
    assert_eq!(
        call(&app, fx.admin, reqwest::Method::GET, &why, None)
            .await
            .0,
        404
    );
    let (status, _) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        secret,
        user_target(fx.admin),
        "read",
    )
    .await;
    assert_eq!(status, 403, "no silent way in through a rule on themselves");
    assert_eq!(
        rule_count(&app.db, "channel_id", secret, ("user_id", fx.admin)).await,
        0
    );
    assert!(
        !can(
            &app,
            &fx,
            fx.admin,
            Resource::Channel(secret),
            Permission::ChannelView
        )
        .await
    );
    let (status, _) = remove(&app, fx.admin, fx.space_id, "channel", secret, someone).await;
    assert_eq!(status, 403);
    assert_eq!(
        rule_count(&app.db, "channel_id", secret, ("group_id", group)).await,
        1
    );

    // The owner reads without joining, and so manages.
    assert_eq!(
        read(&app, fx.owner, fx.space_id, "channel", secret).await.0,
        200
    );
    assert_eq!(
        call(&app, fx.owner, reqwest::Method::GET, &why, None)
            .await
            .0,
        200
    );
    // The channel's own moderator manages it.
    join_as(&app.db, secret, fx.member, "admin").await;
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "channel",
        secret,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    // An administrator who is in the channel is a space editor again.
    join_as(&app.db, secret, fx.admin, "member").await;
    assert_eq!(
        read(&app, fx.admin, fx.space_id, "channel", secret).await.0,
        200
    );
    let (status, _) = remove(&app, fx.admin, fx.space_id, "channel", secret, someone).await;
    assert_eq!(status, 204);
}

#[tokio::test]
async fn an_author_may_aim_a_rule_at_a_group_that_holds_someone_above_them_no_more() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let mine = make_node(&app.db, fx.space_id, fx.member, "mine.txt", "file", None).await;
    let boss = make_group(&app.db, fx.space_id, "Direction").await;
    put_in_group(&app.db, boss, fx.space_id, fx.admin, false).await;
    let peers = make_group(&app.db, fx.space_id, "Pairs").await;
    put_in_group(&app.db, peers, fx.space_id, fx.member, false).await;

    // A group with an administrator in it is above an author, whatever roles it carries.
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "file",
        mine,
        group_target(boss),
        "read",
    )
    .await;
    assert_eq!((status, &body["reason"]), (403, &json!("target_above_you")));
    // An owner in it as well.
    let owners = make_group(&app.db, fx.space_id, "Fondateurs").await;
    put_in_group(&app.db, owners, fx.space_id, fx.owner, false).await;
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "file",
        mine,
        group_target(owners),
        "read",
    )
    .await;
    assert_eq!((status, &body["reason"]), (403, &json!("target_above_you")));
    // A group the author is in is already refused; one of equals is not.
    let friends = make_group(&app.db, fx.space_id, "Amis").await;
    let friend = make_user(&app.db, "friend").await;
    exec(
        &app.db,
        "INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')",
        vec![fx.space_id.into(), friend.into()],
    )
    .await;
    put_in_group(&app.db, friends, fx.space_id, friend, false).await;
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "file",
        mine,
        group_target(friends),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    // The administrator is not held by it.
    let (status, _) = put(
        &app,
        fx.admin,
        fx.space_id,
        "file",
        mine,
        group_target(boss),
        "read",
    )
    .await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn an_author_shares_with_a_channel_they_read_but_never_denies_it() {
    let Some(app) = licensed().await else { return };
    let fx = ladder(&app.db).await;
    let mine = make_node(&app.db, fx.space_id, fx.member, "mine.txt", "file", None).await;
    let room = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let target = json!({ "kind": "audience", "id": room });

    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "file",
        mine,
        target.clone(),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "file",
        mine,
        target.clone(),
        "read",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let line = id_of(
        body["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .find(|e| e["target"]["kind"] == "audience")
            .expect("audience line"),
    );
    // A deny aimed at readers they are among is refused, and so is taking one away.
    let (status, body) = put(
        &app,
        fx.member,
        fx.space_id,
        "file",
        mine,
        json!({ "kind": "audience", "id": room }),
        "none",
    )
    .await;
    assert_eq!((status, &body["reason"]), (403, &json!("target_above_you")));
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "file",
        mine,
        target.clone(),
        "none",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    // They no longer hold the view the deny took from the readers, so they cannot raise it back.
    let (status, _) = put(&app, fx.member, fx.space_id, "file", mine, target, "read").await;
    assert_eq!(status, 403);
    let (status, body) = remove(&app, fx.member, fx.space_id, "file", mine, line).await;
    assert_eq!((status, &body["reason"]), (403, &json!("target_above_you")));
}

#[tokio::test]
async fn a_group_in_use_names_only_what_the_caller_can_open() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let open = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let secret = make_channel(&app.db, fx.space_id, "secret", "private").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    for channel in [open, secret] {
        stored(
            &app.db,
            fx.space_id,
            ("channel_id", channel),
            ("group_id", group),
            &["channel.view"],
            &[],
        )
        .await;
    }
    // A folder hidden from the members: the administrator opens it, the group manager does not need to.
    let url = format!("/api/v1/spaces/{}/groups/{group}", fx.space_id);
    let (status, body) = call(&app, fx.admin, reqwest::Method::DELETE, &url, None).await;
    assert_eq!(status, 409, "{body}");
    let used = body["used_in"].as_array().expect("used_in");
    assert_eq!(used.len(), 2, "{body}");
    assert!(names_place(used, "channel", open, "salon"));
    assert!(
        used.contains(&json!({ "kind": "channel", "hidden": true })),
        "the private channel the administrator never joined is not named: {body}"
    );
    assert!(!body.to_string().contains(&secret.to_string()));
    assert!(!body.to_string().contains("secret"));
    // The owner reads private channels without joining.
    let (status, body) = call(&app, fx.owner, reqwest::Method::DELETE, &url, None).await;
    assert_eq!(status, 409, "{body}");
    assert!(names_place(
        body["used_in"].as_array().expect("used_in"),
        "channel",
        secret,
        "secret"
    ));
}

#[tokio::test]
async fn person_level_denies_are_shown_to_editors_only() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let friend = make_user(&app.db, "friend").await;
    exec(
        &app.db,
        "INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')",
        vec![fx.space_id.into(), friend.into()],
    )
    .await;
    let file = make_node(&app.db, fx.space_id, fx.owner, "plan.txt", "file", None).await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("user_id", fx.member),
        &[],
        &["files.edit"],
    )
    .await;
    stored(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("user_id", friend),
        &["files.view"],
        &[],
    )
    .await;

    let (status, body) = read(&app, fx.admin, fx.space_id, "file", file).await;
    assert_eq!(status, 200);
    assert!(
        entry_of(&body, "user", fx.member).is_some(),
        "editors see it"
    );
    let (status, body) = read(&app, friend, fx.space_id, "file", file).await;
    assert_eq!(status, 200);
    assert!(
        entry_of(&body, "user", fx.member).is_none(),
        "a reader does not learn who is denied what: {body}"
    );
    assert!(
        entry_of(&body, "user", friend).is_some(),
        "an allow is not hidden"
    );
}

// -- the public write path (`write_entry`), as an edition calls it ---------------------------------

use crate::auth::extract::AuthSession;
use crate::permissions::catalogue::PermissionSet;
use crate::permissions::levels::{rule_sets, Kind, Level, Target};
use crate::permissions::rule_routes::{write_entry, Change, Pick};
use crate::permissions::rules::ResourceRef;

fn session_of(user: Uuid) -> AuthSession {
    AuthSession {
        user_id: user,
        session_id: "test".to_owned(),
        mfa_level: "none".to_owned(),
    }
}

/// The error code of a refused write: the `BadRequestCode` code, `not_found`, or `other`.
fn refusal<T>(result: Result<T, crate::messaging::error::ApiError>) -> &'static str {
    use crate::messaging::error::ApiError;
    match result {
        Ok(_) => "ok",
        Err(ApiError::BadRequestCode { code, .. }) => code,
        Err(ApiError::NotFound) => "not_found",
        Err(_) => "other",
    }
}

#[tokio::test]
async fn write_entry_validates_the_sets_itself() {
    let Some(app) = licensed().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let owner = session_of(fx.owner);
    let go = |allow: PermissionSet, deny: PermissionSet| {
        write_entry(
            &app.state,
            &owner,
            fx.space_id,
            ResourceRef::Channel(channel),
            Pick::Group(group),
            Change::Sets { allow, deny },
        )
    };
    // A space-level permission is no rule on a channel, whatever the caller built.
    let invite = PermissionSet::of(&[Permission::MembersInvite]);
    assert_eq!(
        refusal(go(invite, PermissionSet::EMPTY).await),
        "wrong_family"
    );
    assert_eq!(
        refusal(go(PermissionSet::EMPTY, invite).await),
        "wrong_family"
    );
    // A permission of another family.
    let files = PermissionSet::of(&[Permission::FilesView]);
    assert_eq!(
        refusal(go(files, PermissionSet::EMPTY).await),
        "wrong_family"
    );
    // One permission on both sides.
    let send = PermissionSet::of(&[Permission::MessageSend]);
    assert_eq!(refusal(go(send, send).await), "permission_in_both");
    assert!(rules_on(&app.db, "channel_id", channel).await.is_empty());
}

#[tokio::test]
async fn sets_on_a_base_role_must_be_exactly_a_level() {
    let Some(app) = licensed().await else { return };
    let fx = ladder(&app.db).await;
    let calendar = space_calendar(&app.db, fx.space_id, "admins").await;
    let (allow, deny) =
        rule_sets(Kind::Calendar, Target::Everyone, Level::Contribute).expect("sets");
    let missing_write = allow.minus(PermissionSet::of(&[Permission::CalendarWrite]));
    assert_ne!(missing_write, allow, "Contribute carries calendar.write");
    let owner = session_of(fx.owner);
    let go = |allow, deny| {
        write_entry(
            &app.state,
            &owner,
            fx.space_id,
            ResourceRef::Calendar(calendar),
            Pick::Everyone(None),
            Change::Sets { allow, deny },
        )
    };
    assert_eq!(
        refusal(go(missing_write, deny).await),
        "base_role_levels_only"
    );
    assert_eq!(write_access(&app.db, calendar).await, "admins");
    assert!(rules_on(&app.db, "calendar_id", calendar).await.is_empty());
    // The exact sets of the level are the level.
    assert_eq!(refusal(go(allow, deny).await), "ok");
    assert_eq!(write_access(&app.db, calendar).await, "members");
}

#[tokio::test]
async fn empty_sets_are_a_deletion() {
    let Some(app) = licensed().await else { return };
    let fx = ladder(&app.db).await;
    let admin = session_of(fx.admin);
    let empty = Change::Sets {
        allow: PermissionSet::EMPTY,
        deny: PermissionSet::EMPTY,
    };

    // Bridged: two calendars in the same state, one closed by DELETE, one by empty sets.
    let by_delete = space_calendar(&app.db, fx.space_id, "members").await;
    let by_sets = space_calendar(&app.db, fx.space_id, "members").await;
    for calendar in [by_delete, by_sets] {
        let (status, _) = put(
            &app,
            fx.admin,
            fx.space_id,
            "calendar",
            calendar,
            everyone(),
            "read",
        )
        .await;
        assert_eq!(status, 200);
    }
    let (_, body) = read(&app, fx.admin, fx.space_id, "calendar", by_delete).await;
    let rule_id: Option<Uuid> = everyone_entry(&body)["id"]
        .as_str()
        .map(|s| s.parse().expect("uuid"));
    assert!(
        rule_id.is_some(),
        "the lowered calendar keeps a rule: {body}"
    );
    let deleted_with_rule = match rule_id {
        Some(id) => {
            remove(&app, fx.admin, fx.space_id, "calendar", by_delete, id)
                .await
                .0
        }
        None => 404,
    };
    let sets_result = refusal(
        write_entry(
            &app.state,
            &admin,
            fx.space_id,
            ResourceRef::Calendar(by_sets),
            Pick::Everyone(None),
            empty,
        )
        .await,
    );
    // Same answer as DELETE on the same state (a rule there: gone; none: not found)...
    assert_eq!(
        sets_result == "ok",
        deleted_with_rule == 204,
        "{sets_result} / {deleted_with_rule}"
    );
    // ...and the same legacy setting afterwards.
    assert_eq!(
        write_access(&app.db, by_sets).await,
        write_access(&app.db, by_delete).await
    );

    // Not bridged: a group's rule on a channel, then none.
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let clear = || {
        write_entry(
            &app.state,
            &admin,
            fx.space_id,
            ResourceRef::Channel(channel),
            Pick::Group(group),
            empty,
        )
    };
    // No rule: not a silent no-op, a 404 like DELETE.
    assert_eq!(refusal(clear().await), "not_found");
    let (status, _) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(refusal(clear().await), "ok");
    assert_eq!(
        rule_count(&app.db, "channel_id", channel, ("group_id", group)).await,
        0
    );
    let actions: Vec<String> = audit_rows(&app.db, fx.space_id)
        .await
        .into_iter()
        .map(|(a, _)| a)
        .collect();
    assert_eq!(actions.last().map(String::as_str), Some("rule.deleted"));
}

#[tokio::test]
async fn the_dialog_says_what_the_viewer_holds_here() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    join_as(&app.db, channel, fx.member, "admin").await;
    let (status, body) = read(&app, fx.member, fx.space_id, "channel", channel).await;
    assert_eq!(status, 200, "{body}");
    let held: Vec<String> = body["may"]["held"]
        .as_array()
        .unwrap_or_else(|| panic!("held in {body}"))
        .iter()
        .map(|p| p.as_str().expect("name").to_owned())
        .collect();
    assert!(!held.is_empty());
    for permission in Permission::ALL {
        let family_here = permission.family() == crate::permissions::catalogue::Family::Channel
            && permission.resource_level();
        let expected =
            family_here && can(&app, &fx, fx.member, Resource::Channel(channel), permission).await;
        assert_eq!(
            held.iter().any(|h| h == permission.name()),
            expected,
            "{}",
            permission.name()
        );
    }
    // Somebody who edits nothing here holds nothing to show.
    let other = make_channel(&app.db, fx.space_id, "autre", "public").await;
    let (status, body) = read(&app, fx.member, fx.space_id, "channel", other).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["may"]["held"], json!([]));
}

#[tokio::test]
async fn rule_log_lines_carry_the_names_at_write_time() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 200);
    let rule: Uuid = entry_of(&body, "group", group).expect("line")["id"]
        .as_str()
        .expect("id")
        .parse()
        .expect("uuid");
    let (status, _) = remove(&app, fx.admin, fx.space_id, "channel", channel, rule).await;
    assert_eq!(status, 204);
    let lines = audit_rows(&app.db, fx.space_id).await;
    let ours: Vec<&Value> = lines
        .iter()
        .filter(|(_, d)| d["target_id"] == group.to_string())
        .map(|(_, d)| d)
        .collect();
    assert_eq!(ours.len(), 2, "{lines:?}");
    for details in ours {
        assert_eq!(details["resource_name"], "salon");
        assert_eq!(details["target_name"], "Compta");
    }
}

// -- who set a rule, for the people who edit the access ---------------------------------------------

#[tokio::test]
async fn a_rule_says_who_set_it_to_editors() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let (status, body) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "contribute",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let entry = entry_of(&body, "group", group).expect("the group line");
    assert_eq!(entry["set_by"], json!({ "id": fx.admin, "name": "admin" }));
    assert!(entry["set_at"].is_string(), "{entry}");
    time::OffsetDateTime::parse(
        entry["set_at"].as_str().expect("set_at"),
        &time::format_description::well_known::Rfc3339,
    )
    .expect("an RFC 3339 instant");

    // Another editor reads the same author; a line nobody set (a base role) says nothing.
    let (status, body) = read(&app, fx.owner, fx.space_id, "channel", channel).await;
    assert_eq!(status, 200);
    assert_eq!(
        entry_of(&body, "group", group).expect("line")["set_by"]["id"],
        json!(fx.admin)
    );
    let base = body["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .find(|e| e["id"].is_null())
        .expect("a base line");
    assert!(base["set_by"].is_null() && base["set_at"].is_null());

    // A rule from before the migration has no author and no date.
    let old = make_group(&app.db, fx.space_id, "Ancienne").await;
    stored(
        &app.db,
        fx.space_id,
        ("channel_id", channel),
        ("group_id", old),
        &["channel.view"],
        &[],
    )
    .await;
    let (_, body) = read(&app, fx.admin, fx.space_id, "channel", channel).await;
    let entry = entry_of(&body, "group", old).expect("the old line");
    assert!(entry["set_by"].is_null() && entry["set_at"].is_null());
}

#[tokio::test]
async fn a_reader_who_cannot_edit_sees_no_author() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let (status, _) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 200);
    let (status, body) = read(&app, fx.member, fx.space_id, "channel", channel).await;
    assert_eq!(status, 200);
    assert_eq!(body["may"]["edit"], false);
    let entry = entry_of(&body, "group", group).expect("the group line");
    assert!(entry["set_by"].is_null(), "{entry}");
    assert!(entry["set_at"].is_null(), "{entry}");
}

#[tokio::test]
async fn an_update_moves_the_author() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let (_, first) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "read",
    )
    .await;
    let first_at = entry_of(&first, "group", group).expect("line")["set_at"].clone();
    let (status, second) = put(
        &app,
        fx.owner,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "contribute",
    )
    .await;
    assert_eq!(status, 200, "{second}");
    let entry = entry_of(&second, "group", group).expect("line");
    assert_eq!(entry["set_by"]["id"], json!(fx.owner));
    assert_ne!(entry["set_at"], first_at, "the date moves with the author");
    // The creator stays what it was; only the author of the last change moves.
    let created_by: Option<Uuid> = app
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT created_by FROM permission_overrides WHERE channel_id = $1",
            [channel.into()],
        ))
        .await
        .expect("row")
        .expect("one")
        .try_get("", "created_by")
        .expect("created_by");
    assert_eq!(created_by, Some(fx.admin));
}

#[tokio::test]
async fn a_removed_author_reads_as_null() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let (status, _) = put(
        &app,
        fx.admin,
        fx.space_id,
        "channel",
        channel,
        group_target(group),
        "read",
    )
    .await;
    assert_eq!(status, 200);
    // They leave the space: no stale name.
    exec(
        &app.db,
        "DELETE FROM space_members WHERE space_id = $1 AND user_id = $2",
        vec![fx.space_id.into(), fx.admin.into()],
    )
    .await;
    let (status, body) = read(&app, fx.owner, fx.space_id, "channel", channel).await;
    assert_eq!(status, 200);
    let entry = entry_of(&body, "group", group).expect("line");
    assert!(entry["set_by"].is_null(), "{entry}");

    // Their account going away clears the column and keeps the rule.
    exec(
        &app.db,
        "DELETE FROM users WHERE id = $1",
        vec![fx.admin.into()],
    )
    .await;
    let (_, body) = read(&app, fx.owner, fx.space_id, "channel", channel).await;
    assert!(entry_of(&body, "group", group).expect("line")["set_by"].is_null());
}
