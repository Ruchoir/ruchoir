//! The `file_shares` routes (list, share with a person or a channel, remove), now backed by rules:
//! a share grants access for real, goes through the same checks as the Access dialog, is logged,
//! and keeps the wire shapes the older apps read. Rows of the old table stay inert.

use super::*;

use crate::permissions::catalogue::Permission;
use crate::permissions::check::{self, Resource};

use super::permissions_tests::{join_as, ladder, Ladder};

async fn exec(db: &DatabaseConnection, sql: &str, values: Vec<sea_orm::Value>) {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .await
    .expect(sql);
}

async fn make_file(db: &DatabaseConnection, space: Uuid, owner: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    exec(
        db,
        "INSERT INTO files (id, space_id, owner_id, name, kind) VALUES ($1, $2, $3, $4, 'file')",
        vec![id.into(), space.into(), owner.into(), name.into()],
    )
    .await;
    id
}

async fn add_member(db: &DatabaseConnection, space: Uuid, name: &str, role: &str) -> Uuid {
    let user = make_user(db, name).await;
    space_members::ActiveModel {
        space_id: Set(space),
        user_id: Set(user),
        role: Set(role.to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("member");
    user
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

async fn shares_of(app: &TestApp, who: Uuid, file: Uuid) -> (u16, Value) {
    call(
        app,
        who,
        reqwest::Method::GET,
        &format!("/api/v1/files/{file}/shares"),
        None,
    )
    .await
}

async fn share(app: &TestApp, who: Uuid, file: Uuid, body: Value) -> (u16, Value) {
    call(
        app,
        who,
        reqwest::Method::POST,
        &format!("/api/v1/files/{file}/shares"),
        Some(body),
    )
    .await
}

async fn unshare(app: &TestApp, who: Uuid, file: Uuid, id: &str) -> (u16, Value) {
    call(
        app,
        who,
        reqwest::Method::DELETE,
        &format!("/api/v1/files/{file}/shares/{id}"),
        None,
    )
    .await
}

async fn rename(app: &TestApp, who: Uuid, file: Uuid) -> u16 {
    call(
        app,
        who,
        reqwest::Method::PATCH,
        &format!("/api/v1/files/{file}"),
        Some(json!({ "name": "renamed.txt" })),
    )
    .await
    .0
}

/// The file stops being the whole space's: the members' line is "no access".
async fn hide_from_members(app: &TestApp, fx: &Ladder, file: Uuid) {
    let (status, body) = call(
        app,
        fx.admin,
        reqwest::Method::PUT,
        &format!("/api/v1/spaces/{}/access/file/{file}/entries", fx.space_id),
        Some(json!({ "target": { "kind": "everyone" }, "level": "none" })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
}

async fn rules(db: &DatabaseConnection, file: Uuid) -> Vec<(Uuid, Vec<String>, Vec<String>)> {
    db.query_all_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT o.id, o.allow, o.deny FROM permission_overrides o \
          LEFT JOIN space_roles r ON r.id = o.role_id \
         WHERE o.file_id = $1 AND r.system_key IS NULL AND o.role_id IS NULL \
         ORDER BY o.created_at, o.id",
        [file.into()],
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

async fn audit(db: &DatabaseConnection, space: Uuid) -> Vec<(String, Value)> {
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

async fn can(app: &TestApp, fx: &Ladder, user: Uuid, file: Uuid, p: Permission) -> bool {
    check::can(&app.db, fx.space_id, user, Resource::File(file), p)
        .await
        .expect("can")
}

#[tokio::test]
async fn sharing_a_file_with_a_person_lets_them_read_it() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "plan.txt").await;
    hide_from_members(&app, &fx, file).await;
    assert_eq!(shares_of(&app, fx.member, file).await.0, 403);

    let (status, body) = share(
        &app,
        fx.admin,
        file,
        json!({ "target_user_id": fx.member, "permission": "view" }),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["permission"], "view");
    assert_eq!(shares_of(&app, fx.member, file).await.0, 200);
    assert!(can(&app, &fx, fx.member, file, Permission::FilesView).await);

    let (status, listing) = call(
        &app,
        fx.member,
        reqwest::Method::GET,
        &format!("/api/v1/spaces/{}/files", fx.space_id),
        None,
    )
    .await;
    assert_eq!(status, 200, "{listing}");
    assert!(
        listing.to_string().contains(&file.to_string()),
        "the shared file is listed: {listing}"
    );

    // Removing the share takes the access away again.
    let id = body["id"].as_str().expect("id").to_owned();
    assert_eq!(unshare(&app, fx.admin, file, &id).await.0, 204);
    assert_eq!(shares_of(&app, fx.member, file).await.0, 403);
}

#[tokio::test]
async fn edit_means_modifier() {
    use crate::files::authz::ensure_content_editable;

    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "plan.txt").await;
    // Guests hold nothing on a file by default, so what a share gives shows exactly.
    let viewer = add_member(&app.db, fx.space_id, "viewer", "guest").await;
    let editor = fx.guest;

    let (status, _) = share(
        &app,
        fx.admin,
        file,
        json!({ "target_user_id": editor, "permission": "edit" }),
    )
    .await;
    assert_eq!(status, 201);
    let (status, _) = share(
        &app,
        fx.admin,
        file,
        json!({ "target_user_id": viewer, "permission": "view" }),
    )
    .await;
    assert_eq!(status, 201);

    assert!(ensure_content_editable(&app.db, file, editor).await.is_ok());
    assert!(ensure_content_editable(&app.db, file, viewer)
        .await
        .is_err());
    assert!(can(&app, &fx, viewer, file, Permission::FilesView).await);
    // Modifier is not Gerer: no renaming.
    assert!(can(&app, &fx, editor, file, Permission::FilesEdit).await);
    assert!(!can(&app, &fx, editor, file, Permission::FilesManage).await);
    assert_eq!(rename(&app, editor, file).await, 403);

    // The list says which is which.
    let (_, listing) = shares_of(&app, fx.admin, file).await;
    let word = |user: Uuid| {
        listing
            .as_array()
            .expect("list")
            .iter()
            .find(|s| s["target_user_id"] == user.to_string())
            .map(|s| s["permission"].clone())
    };
    assert_eq!(word(editor), Some(json!("edit")));
    assert_eq!(word(viewer), Some(json!("view")));
}

#[tokio::test]
async fn sharing_with_a_channel_reaches_its_readers_only() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let secret = make_channel(&app.db, fx.space_id, "secret", "private").await;
    let reader = add_member(&app.db, fx.space_id, "reader", "member").await;
    join_as(&app.db, secret, reader, "member").await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "plan.txt").await;
    hide_from_members(&app, &fx, file).await;

    let (status, body) = share(
        &app,
        fx.admin,
        file,
        json!({ "target_channel_id": secret, "permission": "view" }),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["target_channel_id"], secret.to_string());
    assert!(body.get("target_user_id").is_none());

    assert_eq!(shares_of(&app, reader, file).await.0, 200);
    // A member outside the private channel stays out.
    assert_eq!(shares_of(&app, fx.member, file).await.0, 403);

    let (_, listing) = shares_of(&app, fx.owner, file).await;
    assert_eq!(listing.as_array().expect("list").len(), 1);
    assert_eq!(listing[0]["target_channel_id"], secret.to_string());
}

#[tokio::test]
async fn a_share_is_a_rule_and_is_logged() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "plan.txt").await;

    let (status, first) = share(
        &app,
        fx.admin,
        file,
        json!({ "target_user_id": fx.member, "permission": "view" }),
    )
    .await;
    assert_eq!(status, 201, "{first}");
    assert_eq!(first["shared_by"], fx.admin.to_string());
    let rows = rules(&app.db, file).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0.to_string(), first["id"].as_str().expect("id"));
    assert_eq!(rows[0].1, vec!["files.view".to_owned()]);

    // Asking again for another level moves the same rule: 200, one line.
    let (status, second) = share(
        &app,
        fx.admin,
        file,
        json!({ "target_user_id": fx.member, "permission": "edit" }),
    )
    .await;
    assert_eq!(status, 200, "{second}");
    assert_eq!(second["id"], first["id"]);
    assert_eq!(second["permission"], "edit");
    assert_eq!(rules(&app.db, file).await.len(), 1);
    // And back down.
    let (status, third) = share(
        &app,
        fx.admin,
        file,
        json!({ "target_user_id": fx.member, "permission": "view" }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(third["permission"], "view");

    let id = first["id"].as_str().expect("id").to_owned();
    assert_eq!(unshare(&app, fx.admin, file, &id).await.0, 204);
    assert!(rules(&app.db, file).await.is_empty());
    // A second removal finds nothing.
    assert_eq!(unshare(&app, fx.admin, file, &id).await.0, 404);

    let log = audit(&app.db, fx.space_id).await;
    let actions: Vec<&str> = log.iter().map(|(a, _)| a.as_str()).collect();
    assert_eq!(
        actions,
        [
            "rule.created",
            "rule.updated",
            "rule.updated",
            "rule.deleted"
        ]
    );
    assert_eq!(log[0].1["target_kind"], "user");
    assert_eq!(log[0].1["after"], "read");
    assert_eq!(log[1].1["after"], "contribute");
}

#[tokio::test]
async fn a_share_to_a_guest_is_capped() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "plan.txt").await;

    let (status, body) = share(
        &app,
        fx.admin,
        file,
        json!({ "target_user_id": fx.guest, "permission": "edit" }),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    assert!(can(&app, &fx, fx.guest, file, Permission::FilesEdit).await);
    assert!(!can(&app, &fx, fx.guest, file, Permission::FilesManage).await);
    assert_eq!(rename(&app, fx.guest, file).await, 403);
    let rows = rules(&app.db, file).await;
    assert!(!rows[0].1.contains(&"files.manage".to_owned()));
}

#[tokio::test]
async fn legacy_shares_stay_inert() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "plan.txt").await;
    hide_from_members(&app, &fx, file).await;
    let legacy = Uuid::new_v4();
    exec(
        &app.db,
        "INSERT INTO file_shares (id, file_id, shared_by, target_user_id, permission) \
         VALUES ($1, $2, $3, $4, 'edit')",
        vec![
            legacy.into(),
            file.into(),
            fx.admin.into(),
            fx.member.into(),
        ],
    )
    .await;

    // The old row grants nothing, and is not listed.
    assert_eq!(shares_of(&app, fx.member, file).await.0, 403);
    let (status, listing) = shares_of(&app, fx.owner, file).await;
    assert_eq!(status, 200);
    assert_eq!(listing, json!([]));
    // It is not a rule: removing it by its id answers 404 and leaves the row alone.
    assert_eq!(
        unshare(&app, fx.admin, file, &legacy.to_string()).await.0,
        404
    );
    let left = app
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT count(*) AS n FROM file_shares WHERE id = $1",
            [legacy.into()],
        ))
        .await
        .expect("count")
        .expect("row")
        .try_get::<i64>("", "n")
        .expect("n");
    assert_eq!(left, 1);
}

#[tokio::test]
async fn the_share_routes_keep_their_shapes() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let secret = make_channel(&app.db, fx.space_id, "secret", "private").await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "plan.txt").await;

    let (status, body) = share(&app, fx.admin, file, json!({ "target_user_id": fx.member })).await;
    assert_eq!(status, 201, "{body}");
    let mut keys: Vec<&str> = body
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "created_at",
            "file_id",
            "id",
            "permission",
            "shared_by",
            "target_user_id"
        ]
    );
    assert_eq!(body["permission"], "view", "view is the default");
    assert_eq!(body["file_id"], file.to_string());

    let (status, channel) = share(
        &app,
        fx.admin,
        file,
        json!({ "target_channel_id": secret, "permission": "edit" }),
    )
    .await;
    assert_eq!(status, 201, "{channel}");
    assert_eq!(channel["permission"], "edit");

    let (status, listing) = shares_of(&app, fx.admin, file).await;
    assert_eq!(status, 200);
    let items = listing.as_array().expect("array");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["id"], body["id"], "oldest first");
    assert_eq!(items[1]["id"], channel["id"]);

    // The same refusals as before.
    let stranger = make_user(&app.db, "stranger").await;
    let other = ladder(&app.db).await;
    let foreign = make_channel(&app.db, other.space_id, "elsewhere", "public").await;
    for bad in [
        json!({}),
        json!({ "target_user_id": fx.member, "target_channel_id": secret }),
        json!({ "target_user_id": fx.member, "permission": "own" }),
        json!({ "target_user_id": stranger }),
        json!({ "target_channel_id": foreign }),
        json!({ "target_channel_id": Uuid::new_v4() }),
    ] {
        let (status, answer) = share(&app, fx.admin, file, bad.clone()).await;
        assert_eq!(status, 400, "{bad}: {answer}");
        assert!(answer["message"].is_string());
    }
    // A non editor is refused flatly.
    assert_eq!(
        share(&app, fx.member, file, json!({ "target_user_id": fx.guest }))
            .await
            .0,
        403
    );
    // A removal of an id that is not on this file.
    assert_eq!(
        unshare(&app, fx.admin, file, &Uuid::new_v4().to_string())
            .await
            .0,
        404
    );
}

#[tokio::test]
async fn an_author_still_shares_their_file() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let friend = add_member(&app.db, fx.space_id, "friend", "member").await;
    let mine = make_file(&app.db, fx.space_id, fx.member, "mine.txt").await;
    let not_mine = make_file(&app.db, fx.space_id, fx.owner, "theirs.txt").await;

    let (status, body) = share(
        &app,
        fx.member,
        mine,
        json!({ "target_user_id": friend, "permission": "edit" }),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["shared_by"], fx.member.to_string());
    let (status, _) = shares_of(&app, friend, mine).await;
    assert_eq!(status, 200);

    // Not their file: refused. Aimed above their rank: refused, as in the Access dialog.
    assert_eq!(
        share(
            &app,
            fx.member,
            not_mine,
            json!({ "target_user_id": friend })
        )
        .await
        .0,
        403
    );
    let (status, _) = share(&app, fx.member, mine, json!({ "target_user_id": fx.admin })).await;
    assert_eq!(status, 403);
    let id = body["id"].as_str().expect("id").to_owned();
    assert_eq!(unshare(&app, fx.member, mine, &id).await.0, 204);
}
