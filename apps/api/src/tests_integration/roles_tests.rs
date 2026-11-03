//! Reading a space's roles, and the roles of its members, against a real database.

use super::*;

use super::delegation_tests::{assign, make_role};

async fn roles_of(app: &TestApp, cookie: &str, space: Uuid) -> (u16, Value) {
    let response = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{space}/roles"),
            cookie,
        )
        .send()
        .await
        .expect("roles");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn members_of(app: &TestApp, cookie: &str, space: Uuid) -> Vec<Value> {
    app.req(
        reqwest::Method::GET,
        &format!("/api/v1/spaces/{space}/members"),
        cookie,
    )
    .send()
    .await
    .expect("members")
    .json::<Vec<Value>>()
    .await
    .expect("json")
}

#[tokio::test]
async fn members_read_the_roles_strongest_first() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let member = make_user(&app.db, "member").await;
    let space = crate::testkit::make_space(&app.db, owner, "Roles").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    let accountant = make_role(
        &app.db,
        space,
        "Comptable",
        40,
        &["files.manage", "not.a.permission"],
    )
    .await;
    assign(&app.db, space, member, accountant).await;
    let (status, roles) = roles_of(&app, &app.cookie_for(member).await, space).await;
    assert_eq!(status, 200, "{roles}");
    let names: Vec<&str> = roles
        .as_array()
        .expect("array")
        .iter()
        .map(|r| r["name"].as_str().expect("name"))
        .collect();
    assert_eq!(
        names,
        vec!["Administrator", "Comptable", "@members", "@guests"]
    );
    let comptable = &roles[1];
    assert_eq!(comptable["id"], accountant.to_string());
    assert_eq!(comptable["position"], 40);
    assert_eq!(
        comptable["permissions"],
        json!(["files.manage"]),
        "unknown names dropped"
    );
    assert_eq!(comptable["holders"], 1);
    assert!(comptable.get("system_key").is_none());
    assert_eq!(roles[0]["system_key"], "administrator");
    assert_eq!(roles[2]["system_key"], "members");
    assert_eq!(roles[2]["holders"], 2, "@members: the owner and the member");
    assert_eq!(roles[3]["holders"], 0);
    // A member without roles.manage manages nothing.
    assert!(roles
        .as_array()
        .expect("array")
        .iter()
        .all(|r| r["manageable"] == false));
}

#[tokio::test]
async fn a_guest_cannot_list_roles() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let guest = make_user(&app.db, "guest").await;
    let stranger = make_user(&app.db, "stranger").await;
    let space = crate::testkit::make_space(&app.db, owner, "Roles").await;
    crate::testkit::add_member(&app.db, space, guest, "guest").await;
    for person in [guest, stranger] {
        let (status, _) = roles_of(&app, &app.cookie_for(person).await, space).await;
        assert_eq!(status, 403);
    }
}

#[tokio::test]
async fn manageable_follows_the_callers_rank() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let admin = make_user(&app.db, "admin").await;
    let hr = make_user(&app.db, "hr").await;
    let space = crate::testkit::make_space(&app.db, owner, "Roles").await;
    crate::testkit::add_member(&app.db, space, admin, "admin").await;
    crate::testkit::add_member(&app.db, space, hr, "member").await;
    let hr_role = make_role(
        &app.db,
        space,
        "Ressources humaines",
        50,
        &["roles.manage", "members.manage"],
    )
    .await;
    let accountant = make_role(&app.db, space, "Comptable", 40, &[]).await;
    assign(&app.db, space, hr, hr_role).await;
    let manageable = |roles: &Value| -> Vec<String> {
        roles
            .as_array()
            .expect("array")
            .iter()
            .filter(|r| r["manageable"] == true)
            .map(|r| r["name"].as_str().expect("name").to_owned())
            .collect()
    };
    let (_, roles) = roles_of(&app, &app.cookie_for(owner).await, space).await;
    assert_eq!(
        manageable(&roles),
        vec![
            "Administrator",
            "Ressources humaines",
            "Comptable",
            "@members",
            "@guests"
        ]
    );
    let (_, roles) = roles_of(&app, &app.cookie_for(admin).await, space).await;
    assert_eq!(
        manageable(&roles),
        vec!["Ressources humaines", "Comptable", "@members", "@guests"]
    );
    let (_, roles) = roles_of(&app, &app.cookie_for(hr).await, space).await;
    assert_eq!(manageable(&roles), vec!["Comptable", "@members", "@guests"]);
    let _ = accountant;
}

#[tokio::test]
async fn the_member_list_carries_role_ids_and_who_the_caller_may_manage() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let admin = make_user(&app.db, "admin").await;
    let hr = make_user(&app.db, "hr").await;
    let worker = make_user(&app.db, "worker").await;
    let space = crate::testkit::make_space(&app.db, owner, "Roles").await;
    crate::testkit::add_member(&app.db, space, admin, "admin").await;
    crate::testkit::add_member(&app.db, space, hr, "member").await;
    crate::testkit::add_member(&app.db, space, worker, "member").await;
    let hr_role = make_role(
        &app.db,
        space,
        "Ressources humaines",
        50,
        &["roles.manage", "members.manage"],
    )
    .await;
    let accountant = make_role(&app.db, space, "Comptable", 40, &[]).await;
    assign(&app.db, space, hr, hr_role).await;
    assign(&app.db, space, worker, accountant).await;
    let administrator: Uuid = app
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT id FROM space_roles WHERE space_id = $1 AND system_key = 'administrator'",
            [space.into()],
        ))
        .await
        .expect("q")
        .expect("row")
        .try_get("", "id")
        .expect("id");
    let list = members_of(&app, &app.cookie_for(hr).await, space).await;
    let row = |id: Uuid| {
        list.iter()
            .find(|m| m["user_id"] == id.to_string())
            .expect("listed")
            .clone()
    };
    assert_eq!(row(admin)["role_ids"], json!([administrator.to_string()]));
    assert_eq!(row(worker)["role_ids"], json!([accountant.to_string()]));
    assert_eq!(row(owner)["role_ids"], json!([]));
    assert_eq!(row(worker)["manageable"], true);
    assert_eq!(row(admin)["manageable"], false);
    assert_eq!(row(owner)["manageable"], false);
    assert_eq!(row(hr)["manageable"], false, "never oneself");
    // When each arrived, for "member since" in their profile.
    let since = row(worker)["joined_at"]
        .as_str()
        .expect("joined_at")
        .to_owned();
    assert!(
        time::OffsetDateTime::parse(&since, &time::format_description::well_known::Rfc3339).is_ok(),
        "{since}"
    );
    // A plain member manages nobody.
    let list = members_of(&app, &app.cookie_for(worker).await, space).await;
    assert!(list.iter().all(|m| m["manageable"] == false));
}
