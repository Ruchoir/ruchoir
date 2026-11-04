//! The free group routes against a real database: who may list, create, rename, fill and delete a
//! group, what each refusal says, and that every write is logged and announced.

use super::*;

use sea_orm::TransactionTrait;

use super::delegation_tests::{assign, make_role};
use super::edition_tests::{FrozenEdition, LicensedEdition};
use super::groups_tests::{count, give_role_to_group, make_group, put_in_group};

struct Fx {
    space: Uuid,
    owner: Uuid,
    /// The legacy `admin` role: Administrator, so every right.
    admin: Uuid,
    /// A member holding a custom role at position 50 with `groups.manage` and `roles.manage`.
    hr: Uuid,
    member: Uuid,
    guest: Uuid,
}

async fn fixture(app: &TestApp) -> Fx {
    let owner = make_user(&app.db, "owner").await;
    let admin = make_user(&app.db, "admin").await;
    let hr = make_user(&app.db, "hr").await;
    let member = make_user(&app.db, "member").await;
    let guest = make_user(&app.db, "guest").await;
    let space = crate::testkit::make_space(&app.db, owner, "Groups").await;
    crate::testkit::add_member(&app.db, space, admin, "admin").await;
    crate::testkit::add_member(&app.db, space, hr, "member").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    crate::testkit::add_member(&app.db, space, guest, "guest").await;
    let hr_role = make_role(
        &app.db,
        space,
        "Ressources humaines",
        50,
        &["groups.manage", "roles.manage"],
    )
    .await;
    assign(&app.db, space, hr, hr_role).await;
    Fx {
        space,
        owner,
        admin,
        hr,
        member,
        guest,
    }
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

fn groups_path(space: Uuid) -> String {
    format!("/api/v1/spaces/{space}/groups")
}

fn group_path(space: Uuid, group: Uuid) -> String {
    format!("/api/v1/spaces/{space}/groups/{group}")
}

fn members_path(space: Uuid, group: Uuid) -> String {
    format!("/api/v1/spaces/{space}/groups/{group}/members")
}

async fn add(app: &TestApp, who: Uuid, space: Uuid, group: Uuid, ids: &[Uuid]) -> (u16, Value) {
    call(
        app,
        who,
        reqwest::Method::POST,
        &members_path(space, group),
        Some(json!({ "user_ids": ids })),
    )
    .await
}

async fn remove(app: &TestApp, who: Uuid, space: Uuid, group: Uuid, user: Uuid) -> (u16, Value) {
    call(
        app,
        who,
        reqwest::Method::DELETE,
        &format!("{}/{user}", members_path(space, group)),
        None,
    )
    .await
}

async fn actions(db: &DatabaseConnection, space: Uuid) -> Vec<(String, Value)> {
    db.query_all_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT action, details FROM space_audit_log \
          WHERE space_id = $1 AND action LIKE 'group.%' ORDER BY at, id",
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

async fn make_manager(db: &DatabaseConnection, group: Uuid, user: Uuid) {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE space_group_members SET is_manager = true WHERE group_id = $1 AND user_id = $2",
        [group.into(), user.into()],
    ))
    .await
    .expect("manager");
}

async fn licensed() -> Option<TestApp> {
    boot_as(Arc::new(LicensedEdition), None, |_| {}).await
}

#[tokio::test]
async fn members_list_groups_and_guests_cannot() {
    let Some(app) = boot().await else { return };
    let fx = fixture(&app).await;
    let (b, a) = (
        make_group(&app.db, fx.space, "Bureau").await,
        make_group(&app.db, fx.space, "Accueil").await,
    );
    put_in_group(&app.db, a, fx.space, fx.member, true).await;
    put_in_group(&app.db, a, fx.space, fx.guest, false).await;
    let path = groups_path(fx.space);

    let (status, list) = call(&app, fx.member, reqwest::Method::GET, &path, None).await;
    assert_eq!(status, 200, "{list}");
    let names: Vec<&str> = list
        .as_array()
        .expect("array")
        .iter()
        .map(|g| g["name"].as_str().expect("name"))
        .collect();
    assert_eq!(names, vec!["Accueil", "Bureau"]);
    assert_eq!(list[0]["id"], a.to_string());
    assert_eq!(list[0]["source"], "manual");
    let mut ids = vec![fx.member.to_string(), fx.guest.to_string()];
    ids.sort();
    let mut shown: Vec<String> = list[0]["member_ids"]
        .as_array()
        .expect("ids")
        .iter()
        .map(|v| v.as_str().expect("id").to_owned())
        .collect();
    shown.sort();
    assert_eq!(shown, ids);
    assert_eq!(list[0]["manager_ids"], json!([fx.member.to_string()]));
    assert_eq!(list[0]["role_ids"], json!([]));
    assert!(list[0].get("description").is_none());
    // A plain member may change nothing, not even as a manager of the group (renaming needs the
    // right itself).
    assert_eq!(
        list[0]["may"],
        json!({ "edit": false, "delete": false, "change_members": false, "change_roles": false, "appoint": false })
    );
    let (_, list) = call(&app, fx.admin, reqwest::Method::GET, &path, None).await;
    assert_eq!(list[1]["id"], b.to_string());
    assert_eq!(list[1]["may"]["edit"], true);
    assert_eq!(list[1]["may"]["delete"], true);
    assert_eq!(list[1]["may"]["change_members"], true);
    // Community edition: roles and managers are paid.
    assert_eq!(list[1]["may"]["change_roles"], false);
    assert_eq!(list[1]["may"]["appoint"], false);

    // A guest never reads the directory; a stranger neither.
    let stranger = make_user(&app.db, "stranger").await;
    for person in [fx.guest, stranger] {
        let (status, _) = call(&app, person, reqwest::Method::GET, &path, None).await;
        assert_eq!(status, 403);
    }
}

#[tokio::test]
async fn groups_manage_creates_renames_and_deletes_a_plain_group() {
    let Some(app) = boot().await else { return };
    let fx = fixture(&app).await;
    let path = groups_path(fx.space);

    let (status, body) = call(
        &app,
        fx.member,
        reqwest::Method::POST,
        &path,
        Some(json!({ "name": "Compta" })),
    )
    .await;
    assert_eq!(status, 403, "{body}");

    let (status, created) = call(
        &app,
        fx.admin,
        reqwest::Method::POST,
        &path,
        Some(json!({ "name": "  Compta ", "description": "Les chiffres" })),
    )
    .await;
    assert_eq!(status, 201, "{created}");
    assert_eq!(created["name"], "Compta");
    assert_eq!(created["description"], "Les chiffres");
    assert_eq!(created["member_ids"], json!([]));
    assert_eq!(created["may"]["edit"], true);
    let group: Uuid = created["id"].as_str().expect("id").parse().expect("uuid");

    let (status, renamed) = call(
        &app,
        fx.hr,
        reqwest::Method::PATCH,
        &group_path(fx.space, group),
        Some(json!({ "name": "Comptabilite" })),
    )
    .await;
    assert_eq!(status, 200, "{renamed}");
    assert_eq!(renamed["name"], "Comptabilite");
    assert_eq!(renamed["description"], "Les chiffres", "untouched");
    let (_, cleared) = call(
        &app,
        fx.hr,
        reqwest::Method::PATCH,
        &group_path(fx.space, group),
        Some(json!({ "description": "  " })),
    )
    .await;
    assert!(cleared.get("description").is_none(), "{cleared}");
    let (status, _) = call(
        &app,
        fx.member,
        reqwest::Method::PATCH,
        &group_path(fx.space, group),
        Some(json!({ "name": "Autre" })),
    )
    .await;
    assert_eq!(status, 403);
    let (status, _) = call(
        &app,
        fx.member,
        reqwest::Method::DELETE,
        &group_path(fx.space, group),
        None,
    )
    .await;
    assert_eq!(status, 403);

    let (status, _) = call(
        &app,
        fx.hr,
        reqwest::Method::DELETE,
        &group_path(fx.space, group),
        None,
    )
    .await;
    assert_eq!(status, 204);
    let (status, _) = call(
        &app,
        fx.hr,
        reqwest::Method::DELETE,
        &group_path(fx.space, group),
        None,
    )
    .await;
    assert_eq!(status, 404);
    // Another space's group is no group here.
    let other_owner = make_user(&app.db, "other").await;
    let other = crate::testkit::make_space(&app.db, other_owner, "Other").await;
    let foreign = make_group(&app.db, other, "Etrangere").await;
    let (status, _) = call(
        &app,
        fx.admin,
        reqwest::Method::DELETE,
        &group_path(fx.space, foreign),
        None,
    )
    .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn a_plain_group_stays_editable_without_a_licence() {
    let Some(app) = boot().await else { return };
    let fx = fixture(&app).await;
    let group = make_group(&app.db, fx.space, "Equipe").await;
    let (status, body) = add(&app, fx.hr, fx.space, group, &[fx.member]).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["member_ids"], json!([fx.member.to_string()]));
    let (status, _) = remove(&app, fx.hr, fx.space, group, fx.member).await;
    assert_eq!(status, 204);
    let (status, _) = call(
        &app,
        fx.hr,
        reqwest::Method::DELETE,
        &group_path(fx.space, group),
        None,
    )
    .await;
    assert_eq!(status, 204);

    // Once it carries a role, changing its people needs a licence.
    let role = make_role(&app.db, fx.space, "Comptable", 40, &[]).await;
    let group = make_group(&app.db, fx.space, "Compta").await;
    give_role_to_group(&app.db, group, fx.space, role)
        .await
        .expect("role");
    let (status, body) = add(&app, fx.hr, fx.space, group, &[fx.member]).await;
    assert_eq!(status, 402, "{body}");
    assert_eq!(body["error"], "licence_required");
}

#[tokio::test]
async fn changing_a_role_carrying_group_needs_every_role() {
    let Some(app) = licensed().await else { return };
    let fx = fixture(&app).await;
    let high = make_role(&app.db, fx.space, "Direction", 60, &[]).await;
    let low = make_role(&app.db, fx.space, "Comptable", 40, &[]).await;
    let mixed = make_group(&app.db, fx.space, "Mixte").await;
    give_role_to_group(&app.db, mixed, fx.space, high)
        .await
        .expect("high");
    give_role_to_group(&app.db, mixed, fx.space, low)
        .await
        .expect("low");
    let (status, body) = add(&app, fx.hr, fx.space, mixed, &[fx.member]).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["reason"], "role_above_you");
    let (status, body) = call(
        &app,
        fx.hr,
        reqwest::Method::DELETE,
        &group_path(fx.space, mixed),
        None,
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["reason"], "role_above_you");
    // The screen agrees.
    let (_, list) = call(
        &app,
        fx.hr,
        reqwest::Method::GET,
        &groups_path(fx.space),
        None,
    )
    .await;
    assert_eq!(list[0]["may"]["delete"], false);
    assert_eq!(list[0]["may"]["change_members"], false);

    // The owner needs no rank.
    let (status, _) = add(&app, fx.owner, fx.space, mixed, &[fx.member]).await;
    assert_eq!(status, 200);
    // A group of roles below the actor is theirs.
    let below = make_group(&app.db, fx.space, "Bas").await;
    give_role_to_group(&app.db, below, fx.space, low)
        .await
        .expect("low");
    let (status, _) = add(&app, fx.hr, fx.space, below, &[fx.member]).await;
    assert_eq!(status, 200);
    let (status, _) = call(
        &app,
        fx.hr,
        reqwest::Method::DELETE,
        &group_path(fx.space, below),
        None,
    )
    .await;
    assert_eq!(status, 204);
}

#[tokio::test]
async fn nobody_gives_themselves_a_role_through_a_group() {
    let Some(app) = licensed().await else { return };
    let fx = fixture(&app).await;
    let role = make_role(&app.db, fx.space, "Comptable", 40, &["files.manage"]).await;
    let group = make_group(&app.db, fx.space, "Compta").await;
    give_role_to_group(&app.db, group, fx.space, role)
        .await
        .expect("role");
    let (status, body) = add(&app, fx.hr, fx.space, group, &[fx.hr]).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["reason"], "no_self_role");
    // Nor among others.
    let (status, body) = add(&app, fx.hr, fx.space, group, &[fx.member, fx.hr]).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["reason"], "no_self_role");
    let held: i64 = count(
        &app.db,
        "SELECT count(*)::bigint AS n FROM space_group_members WHERE group_id = $1",
        vec![group.into()],
    )
    .await;
    assert_eq!(held, 0);
    // Someone else may put them in, and the owner may do it for themselves.
    let (status, _) = add(&app, fx.admin, fx.space, group, &[fx.hr]).await;
    assert_eq!(status, 200);
    let (status, _) = add(&app, fx.owner, fx.space, group, &[fx.owner]).await;
    assert_eq!(status, 200);
    // Taking oneself out of a role-carrying group is a plain leave, and is allowed.
    let (status, _) = remove(&app, fx.hr, fx.space, group, fx.hr).await;
    assert_eq!(status, 204);
}

#[tokio::test]
async fn managers_act_only_in_a_licensed_space() {
    for (edition, expected) in [(0, 402), (1, 409), (2, 200)] {
        let app = match edition {
            0 => boot().await,
            1 => boot_as(Arc::new(FrozenEdition), None, |_| {}).await,
            _ => licensed().await,
        };
        let Some(app) = app else { return };
        let fx = fixture(&app).await;
        let group = make_group(&app.db, fx.space, "Equipe").await;
        put_in_group(&app.db, group, fx.space, fx.member, false).await;
        make_manager(&app.db, group, fx.member).await;
        let (status, body) = add(&app, fx.member, fx.space, group, &[fx.hr]).await;
        assert_eq!(status, expected, "edition {edition}: {body}");
        if expected == 402 {
            assert_eq!(body["error"], "licence_required");
        }
        if expected == 409 {
            assert_eq!(body["error"], "licence_frozen");
        }
    }
}

#[tokio::test]
async fn a_manager_cannot_remove_another_manager() {
    let Some(app) = licensed().await else { return };
    let fx = fixture(&app).await;
    let group = make_group(&app.db, fx.space, "Equipe").await;
    let other = make_user(&app.db, "second").await;
    crate::testkit::add_member(&app.db, fx.space, other, "member").await;
    for who in [fx.member, other, fx.hr] {
        put_in_group(&app.db, group, fx.space, who, false).await;
    }
    make_manager(&app.db, group, fx.member).await;
    make_manager(&app.db, group, other).await;

    let (status, body) = remove(&app, fx.member, fx.space, group, other).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["reason"], "manager_protected");
    // A manager removes an ordinary member.
    let (status, _) = remove(&app, fx.member, fx.space, group, fx.hr).await;
    assert_eq!(status, 204);
    // groups.manage removes a manager.
    let (status, _) = remove(&app, fx.admin, fx.space, group, other).await;
    assert_eq!(status, 204);
}

#[tokio::test]
async fn anyone_may_leave_a_group() {
    let Some(app) = boot().await else { return };
    let fx = fixture(&app).await;
    let role = make_role(&app.db, fx.space, "Comptable", 40, &[]).await;
    let group = make_group(&app.db, fx.space, "Compta").await;
    give_role_to_group(&app.db, group, fx.space, role)
        .await
        .expect("role");
    put_in_group(&app.db, group, fx.space, fx.member, false).await;
    put_in_group(&app.db, group, fx.space, fx.guest, false).await;
    // A community space, a group that carries a role: leaving is still free.
    let (status, _) = remove(&app, fx.member, fx.space, group, fx.member).await;
    assert_eq!(status, 204);
    let (status, _) = remove(&app, fx.guest, fx.space, group, fx.guest).await;
    assert_eq!(status, 204);
    // Not in it any more.
    let (status, _) = remove(&app, fx.member, fx.space, group, fx.member).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn a_directory_group_takes_no_hand_edit() {
    let Some(app) = boot().await else { return };
    let fx = fixture(&app).await;
    let group = make_group(&app.db, fx.space, "Annuaire").await;
    put_in_group(&app.db, group, fx.space, fx.member, false).await;
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE space_groups SET source = 'directory', external_id = 'x' WHERE id = $1",
            [group.into()],
        ))
        .await
        .expect("directory");
    let check = |status: u16, body: Value| {
        assert_eq!(status, 409, "{body}");
        assert_eq!(body["error"], "group_from_directory");
    };
    let (s, b) = call(
        &app,
        fx.admin,
        reqwest::Method::PATCH,
        &group_path(fx.space, group),
        Some(json!({ "name": "Autre" })),
    )
    .await;
    check(s, b);
    let (s, b) = call(
        &app,
        fx.admin,
        reqwest::Method::DELETE,
        &group_path(fx.space, group),
        None,
    )
    .await;
    check(s, b);
    let (s, b) = add(&app, fx.admin, fx.space, group, &[fx.hr]).await;
    check(s, b);
    let (s, b) = remove(&app, fx.admin, fx.space, group, fx.member).await;
    check(s, b);
    let (s, b) = remove(&app, fx.member, fx.space, group, fx.member).await;
    check(s, b);
    let (_, list) = call(
        &app,
        fx.admin,
        reqwest::Method::GET,
        &groups_path(fx.space),
        None,
    )
    .await;
    assert_eq!(list[0]["source"], "directory");
    assert_eq!(list[0]["may"]["edit"], false);
}

#[tokio::test]
async fn group_names_are_unique_and_never_a_broadcast() {
    let Some(app) = boot().await else { return };
    let fx = fixture(&app).await;
    let path = groups_path(fx.space);
    let create = |name: &'static str| {
        let (app, path) = (&app, path.clone());
        async move {
            call(
                app,
                fx.admin,
                reqwest::Method::POST,
                &path,
                Some(json!({ "name": name })),
            )
            .await
        }
    };
    for name in [
        "here", "Ici", "CHANNEL", "everyone", "all", "canal", "tous", "Tous",
    ] {
        let (status, body) = create(name).await;
        assert_eq!(
            (status, body["error"].as_str()),
            (400, Some("group_name_reserved")),
            "{name}"
        );
    }
    for name in ["", "   ", "@equipe", "#general"] {
        let (status, _) = create(name).await;
        assert_eq!(status, 400, "{name:?}");
    }
    let (status, _) = create(&"x".repeat(61).leak()[..]).await;
    assert_eq!(status, 400);
    let (status, first) = create("Comptabilite").await;
    assert_eq!(status, 201, "{first}");
    let (status, body) = create("COMPTABILITE").await;
    assert_eq!(
        (status, body["error"].as_str()),
        (409, Some("group_name_taken"))
    );
    let (status, second) = create("Accueil").await;
    assert_eq!(status, 201, "{second}");
    let id = second["id"].as_str().expect("id");
    let (status, body) = call(
        &app,
        fx.admin,
        reqwest::Method::PATCH,
        &format!("{path}/{id}"),
        Some(json!({ "name": "comptabilite" })),
    )
    .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (409, Some("group_name_taken"))
    );
    let (status, body) = call(
        &app,
        fx.admin,
        reqwest::Method::PATCH,
        &format!("{path}/{id}"),
        Some(json!({ "name": "Tous" })),
    )
    .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (400, Some("group_name_reserved"))
    );
    // Renaming to its own name is no clash.
    let (status, _) = call(
        &app,
        fx.admin,
        reqwest::Method::PATCH,
        &format!("{path}/{id}"),
        Some(json!({ "name": "ACCUEIL" })),
    )
    .await;
    assert_eq!(status, 200);
    // A description is capped.
    let (status, _) = call(
        &app,
        fx.admin,
        reqwest::Method::PATCH,
        &format!("{path}/{id}"),
        Some(json!({ "description": "x".repeat(281) })),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn people_must_be_in_the_space_to_join_a_group() {
    let Some(app) = boot().await else { return };
    let fx = fixture(&app).await;
    let group = make_group(&app.db, fx.space, "Equipe").await;
    let stranger = make_user(&app.db, "stranger").await;
    let (status, body) = add(&app, fx.admin, fx.space, group, &[fx.member, stranger]).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "not_in_space");
    // All or nothing.
    let (_, list) = call(
        &app,
        fx.admin,
        reqwest::Method::GET,
        &groups_path(fx.space),
        None,
    )
    .await;
    assert_eq!(list[0]["member_ids"], json!([]));
    // Any standing, a guest too; and twice in one request is once.
    let (status, body) = add(&app, fx.admin, fx.space, group, &[fx.guest, fx.guest]).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["member_ids"], json!([fx.guest.to_string()]));
}

#[tokio::test]
async fn every_group_write_is_logged_and_announced() {
    let Some(app) = boot().await else { return };
    let fx = fixture(&app).await;
    let mut watching = app.connect_ws(&app.cookie_for(fx.member).await).await;
    let path = groups_path(fx.space);

    let (status, created) = call(
        &app,
        fx.admin,
        reqwest::Method::POST,
        &path,
        Some(json!({ "name": "Compta", "description": "Chiffres" })),
    )
    .await;
    assert_eq!(status, 201);
    let group: Uuid = created["id"].as_str().expect("id").parse().expect("uuid");
    expect_permissions_changed(&mut watching, fx.space).await;

    let (status, _) = call(
        &app,
        fx.admin,
        reqwest::Method::PATCH,
        &group_path(fx.space, group),
        Some(json!({ "name": "Comptabilite" })),
    )
    .await;
    assert_eq!(status, 200);
    expect_permissions_changed(&mut watching, fx.space).await;

    let (status, _) = add(&app, fx.admin, fx.space, group, &[fx.member, fx.guest]).await;
    assert_eq!(status, 200);
    expect_permissions_changed(&mut watching, fx.space).await;

    // Nothing to do: nothing written, nothing announced.
    let before = actions(&app.db, fx.space).await.len();
    let (status, _) = add(&app, fx.admin, fx.space, group, &[fx.member]).await;
    assert_eq!(status, 200);
    let (status, _) = call(
        &app,
        fx.admin,
        reqwest::Method::PATCH,
        &group_path(fx.space, group),
        Some(json!({ "name": "Comptabilite", "description": "Chiffres" })),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = remove(&app, fx.admin, fx.space, group, fx.hr).await;
    assert_eq!(status, 204);
    assert_eq!(actions(&app.db, fx.space).await.len(), before);
    expect_no_permissions_changed(&mut watching).await;

    let (status, _) = remove(&app, fx.admin, fx.space, group, fx.guest).await;
    assert_eq!(status, 204);
    expect_permissions_changed(&mut watching, fx.space).await;
    let (status, _) = call(
        &app,
        fx.admin,
        reqwest::Method::DELETE,
        &group_path(fx.space, group),
        None,
    )
    .await;
    assert_eq!(status, 204);
    expect_permissions_changed(&mut watching, fx.space).await;

    let log = actions(&app.db, fx.space).await;
    let names: Vec<&str> = log.iter().map(|(a, _)| a.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "group.created",
            "group.updated",
            "group.members_added",
            "group.members_removed",
            "group.deleted"
        ]
    );
    assert_eq!(
        log[0].1,
        json!({ "name": "Compta", "description": "Chiffres" })
    );
    assert_eq!(log[1].1["before"]["name"], "Compta");
    assert_eq!(log[1].1["after"]["name"], "Comptabilite");
    let mut added: Vec<String> = log[2].1["user_ids"]
        .as_array()
        .expect("ids")
        .iter()
        .map(|v| v.as_str().expect("id").to_owned())
        .collect();
    added.sort();
    let mut expected = vec![fx.member.to_string(), fx.guest.to_string()];
    expected.sort();
    assert_eq!(added, expected);
    assert_eq!(log[2].1["roles"], json!([]));
    assert_eq!(log[3].1["user_ids"], json!([fx.guest.to_string()]));
    assert_eq!(log[4].1["name"], "Comptabilite");
    assert_eq!(log[4].1["members"], 1);
    assert_eq!(log[4].1["roles"], json!([]));

    // The read API files them under "groups" and names the gone group from the entry.
    let (status, page) = call(
        &app,
        fx.owner,
        reqwest::Method::GET,
        &format!("/api/v1/spaces/{}/audit?category=groups", fx.space),
        None,
    )
    .await;
    assert_eq!(status, 200, "{page}");
    let entries = page["entries"].as_array().expect("entries");
    assert_eq!(entries.len(), 5);
    assert_eq!(entries[0]["action"], "group.deleted");
    assert_eq!(entries[0]["category"], "groups");
    assert_eq!(entries[0]["target"]["kind"], "group");
    assert_eq!(entries[0]["target"]["label"], "Comptabilite");
}

/// Assert no `permissions.changed` reaches the socket in a short window.
pub(super) async fn expect_no_permissions_changed(
    ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(800);
    while let Ok(Some(frame)) = tokio::time::timeout_at(deadline, ws.next()).await {
        if let Ok(WsMessage::Text(text)) = frame {
            if serde_json::from_str::<Value>(text.as_str())
                .is_ok_and(|event| event["type"] == "permissions.changed")
            {
                panic!("expected no permissions.changed but received one");
            }
        }
    }
}

pub(super) async fn expect_permissions_changed(
    ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
    space: Uuid,
) {
    let event = wait_for_type(ws, "permissions.changed").await;
    assert_eq!(event["payload"]["space_id"], space.to_string());
}

#[tokio::test]
async fn concurrent_group_writes_stay_consistent() {
    let Some(app) = boot().await else { return };
    let fx = fixture(&app).await;

    // Two adds of the same people at once: each person is added, and logged, once.
    let group = make_group(&app.db, fx.space, "Course").await;
    let people = [fx.member, fx.guest, fx.hr];
    let (a, b) = tokio::join!(
        add(&app, fx.admin, fx.space, group, &people),
        add(&app, fx.owner, fx.space, group, &people),
    );
    assert_eq!((a.0, b.0), (200, 200), "{a:?} {b:?}");
    let held = count(
        &app.db,
        "SELECT count(*)::bigint AS n FROM space_group_members WHERE group_id = $1",
        vec![group.into()],
    )
    .await;
    assert_eq!(held, 3);
    let logged: usize = actions(&app.db, fx.space)
        .await
        .iter()
        .filter(|(action, _)| action == "group.members_added")
        .map(|(_, details)| details["user_ids"].as_array().map_or(0, Vec::len))
        .sum();
    assert_eq!(logged, 3, "each person is logged as added once");

    // A delete racing an add: either order, no failure, nothing left behind.
    let doomed = make_group(&app.db, fx.space, "Condamnee").await;
    let doomed_path = group_path(fx.space, doomed);
    let joining = [fx.member];
    let (deleted, added) = tokio::join!(
        call(&app, fx.admin, reqwest::Method::DELETE, &doomed_path, None),
        add(&app, fx.owner, fx.space, doomed, &joining),
    );
    assert_eq!(deleted.0, 204, "{deleted:?}");
    assert!(added.0 == 200 || added.0 == 404, "{added:?}");
    let leftovers = count(
        &app.db,
        "SELECT (SELECT count(*) FROM space_group_members WHERE group_id = $1) \
              + (SELECT count(*) FROM space_groups WHERE id = $1) AS n",
        vec![doomed.into()],
    )
    .await;
    assert_eq!(leftovers, 0);

    // A removal racing a writer that behaves like the manager route: lock the group, set the flag
    // only if the person is still in, commit. Whatever the order, nobody ends up managing a group
    // they are no longer in.
    for _ in 0..5 {
        let team = make_group(&app.db, fx.space, &format!("Equipe {}", Uuid::new_v4())).await;
        put_in_group(&app.db, team, fx.space, fx.member, false).await;
        let (removed, ()) = tokio::join!(
            remove(&app, fx.admin, fx.space, team, fx.member),
            appoint_if_still_in(&app.db, team, fx.member),
        );
        assert_eq!(removed.0, 204, "{removed:?}");
        let managing_outside = count(
            &app.db,
            "SELECT count(*)::bigint AS n FROM space_group_members \
              WHERE group_id = $1 AND is_manager AND user_id = $2",
            vec![team.into(), fx.member.into()],
        )
        .await;
        assert_eq!(managing_outside, 0);
        let rows = count(
            &app.db,
            "SELECT count(*)::bigint AS n FROM space_group_members WHERE group_id = $1",
            vec![team.into()],
        )
        .await;
        assert_eq!(rows, 0, "the removal saw them, so they are gone");
    }
}

/// What the manager route will do: lock the group, set the flag if the member row is still there.
async fn appoint_if_still_in(db: &DatabaseConnection, group: Uuid, user: Uuid) {
    let txn = db.begin().await.expect("begin");
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT id FROM space_groups WHERE id = $1 FOR UPDATE",
        [group.into()],
    ))
    .await
    .expect("lock");
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE space_group_members SET is_manager = true WHERE group_id = $1 AND user_id = $2",
        [group.into(), user.into()],
    ))
    .await
    .expect("appoint");
    txn.commit().await.expect("commit");
}

#[tokio::test]
async fn re_adding_oneself_to_a_group_one_is_in_changes_nothing() {
    let Some(app) = licensed().await else { return };
    let fx = fixture(&app).await;
    let role = make_role(&app.db, fx.space, "Comptable", 40, &[]).await;
    let group = make_group(&app.db, fx.space, "Compta").await;
    give_role_to_group(&app.db, group, fx.space, role)
        .await
        .expect("role");
    put_in_group(&app.db, group, fx.space, fx.hr, false).await;
    let before = actions(&app.db, fx.space).await.len();
    let (status, body) = add(&app, fx.hr, fx.space, group, &[fx.hr]).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(actions(&app.db, fx.space).await.len(), before);
    // Authority is still checked when there is nobody to add.
    let (status, _) = add(&app, fx.member, fx.space, group, &[fx.hr]).await;
    assert_eq!(status, 403);
    // And joining a role-carrying group oneself is still refused.
    let (status, body) = add(&app, fx.member, fx.space, group, &[fx.member]).await;
    assert_eq!(status, 403, "{body}");
    let (status, body) = add(&app, fx.hr, fx.space, group, &[fx.hr, fx.member]).await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn at_most_five_hundred_people_at_a_time() {
    let Some(app) = boot().await else { return };
    let fx = fixture(&app).await;
    let group = make_group(&app.db, fx.space, "Equipe").await;
    let many: Vec<Uuid> = (0..501).map(|_| Uuid::new_v4()).collect();
    let (status, body) = add(&app, fx.admin, fx.space, group, &many).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "too_many_people");
    // 500 unknown people are refused for what they are, not for their number.
    let (status, body) = add(&app, fx.admin, fx.space, group, &many[..500]).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "not_in_space");
}

#[tokio::test]
async fn the_member_list_carries_group_ids() {
    let Some(app) = boot().await else { return };
    let fx = fixture(&app).await;
    let (b, a) = (
        make_group(&app.db, fx.space, "Bureau").await,
        make_group(&app.db, fx.space, "Accueil").await,
    );
    put_in_group(&app.db, a, fx.space, fx.member, false).await;
    put_in_group(&app.db, b, fx.space, fx.member, false).await;
    let (status, members) = call(
        &app,
        fx.admin,
        reqwest::Method::GET,
        &format!("/api/v1/spaces/{}/members", fx.space),
        None,
    )
    .await;
    assert_eq!(status, 200);
    let row = |user: Uuid| {
        members
            .as_array()
            .expect("array")
            .iter()
            .find(|m| m["user_id"] == user.to_string())
            .expect("member")
            .clone()
    };
    assert_eq!(
        row(fx.member)["group_ids"],
        json!([a.to_string(), b.to_string()]),
        "by group name"
    );
    assert_eq!(row(fx.admin)["group_ids"], json!([]));
}

// --- Permissions hardening ---

async fn name_in_a_rule(db: &DatabaseConnection, space: Uuid, group: Uuid) {
    let channel: Uuid = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT default_channel_id AS id FROM spaces WHERE id = $1",
            [space.into()],
        ))
        .await
        .expect("query")
        .expect("row")
        .try_get("", "id")
        .expect("id");
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO permission_overrides (space_id, channel_id, group_id, allow, deny) \
         VALUES ($1, $2, $3, ARRAY['channel.view'], ARRAY[]::text[])",
        [space.into(), channel.into(), group.into()],
    ))
    .await
    .expect("rule");
}

#[tokio::test]
async fn nobody_gives_themselves_a_group_that_access_rules_name() {
    let Some(app) = licensed().await else { return };
    let fx = fixture(&app).await;
    // No role, so `no_self_role` never fires: the group matters only because a rule names it.
    let named = make_group(&app.db, fx.space, "Direction").await;
    name_in_a_rule(&app.db, fx.space, named).await;
    let plain = make_group(&app.db, fx.space, "Cafe").await;

    let (status, body) = add(&app, fx.hr, fx.space, named, &[fx.hr]).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["reason"], "no_self_role");
    let (status, body) = add(&app, fx.hr, fx.space, named, &[fx.member, fx.hr]).await;
    assert_eq!(status, 403, "{body}");
    // Someone else may put them in, the owner may do it for themselves, and a group no rule
    // names stays free.
    let (status, _) = add(&app, fx.admin, fx.space, named, &[fx.hr]).await;
    assert_eq!(status, 200);
    let (status, _) = add(&app, fx.owner, fx.space, named, &[fx.owner]).await;
    assert_eq!(status, 200);
    let (status, _) = add(&app, fx.hr, fx.space, plain, &[fx.hr]).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn a_group_manager_cannot_act_on_people_ranked_above_them_in_a_role_group() {
    let Some(app) = licensed().await else { return };
    let fx = fixture(&app).await;
    let low = make_role(&app.db, fx.space, "Comptable", 40, &["files.manage"]).await;
    let high = make_role(&app.db, fx.space, "Direction", 80, &[]).await;
    let boss = make_user(&app.db, "boss").await;
    crate::testkit::add_member(&app.db, fx.space, boss, "member").await;
    assign(&app.db, fx.space, boss, high).await;
    let group = make_group(&app.db, fx.space, "Compta").await;
    give_role_to_group(&app.db, group, fx.space, low)
        .await
        .expect("role");
    put_in_group(&app.db, group, fx.space, fx.member, false).await;
    make_manager(&app.db, group, fx.member).await;
    put_in_group(&app.db, group, fx.space, boss, false).await;

    // Taking the boss out, or bringing the boss in, is above the manager.
    let (status, body) = remove(&app, fx.member, fx.space, group, boss).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["reason"], "person_above_you");
    let other = make_group(&app.db, fx.space, "Compta2").await;
    give_role_to_group(&app.db, other, fx.space, low)
        .await
        .expect("role");
    put_in_group(&app.db, other, fx.space, fx.member, false).await;
    make_manager(&app.db, other, fx.member).await;
    let (status, body) = add(&app, fx.member, fx.space, other, &[boss]).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["reason"], "person_above_you");
    // Someone below them is theirs to add and to remove.
    let (status, _) = add(&app, fx.member, fx.space, group, &[fx.guest]).await;
    assert_eq!(status, 200);
    let (status, _) = remove(&app, fx.member, fx.space, group, fx.guest).await;
    assert_eq!(status, 204);
}
