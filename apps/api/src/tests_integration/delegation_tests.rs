//! The delegation rules against a real database: ranks from the roles held, who may manage which
//! role, who may act on whom, and that custom roles never undo the guest ceiling or the repair.

use super::*;

use crate::permissions::catalogue::PermissionSet;
use crate::permissions::delegation::{ensure_acts_on, ensure_manages_role, rank_of, Rank};
use crate::permissions::system_roles::{GUEST_CEILING, VISIBILITY_DROP};

/// A custom role, placed at `position`, granting `permissions`.
async fn make_role(
    db: &DatabaseConnection,
    space: Uuid,
    name: &str,
    position: i32,
    permissions: &[&str],
) -> Uuid {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO space_roles (space_id, name, position, permissions) VALUES ($1, $2, $3, $4) RETURNING id",
            [
                space.into(),
                name.into(),
                position.into(),
                permissions.iter().map(|p| (*p).to_owned()).collect::<Vec<String>>().into(),
            ],
        ))
        .await
        .expect("role")
        .expect("row");
    row.try_get("", "id").expect("id")
}

async fn assign(db: &DatabaseConnection, space: Uuid, user: Uuid, role: Uuid) {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO space_role_assignments (space_id, user_id, role_id) VALUES ($1, $2, $3)",
        [space.into(), user.into(), role.into()],
    ))
    .await
    .expect("assign");
}

async fn administrator_of(db: &DatabaseConnection, space: Uuid) -> Uuid {
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT id FROM space_roles WHERE space_id = $1 AND system_key = 'administrator'",
        [space.into()],
    ))
    .await
    .expect("query")
    .expect("administrator")
    .try_get("", "id")
    .expect("id")
}

struct People {
    space: Uuid,
    owner: Uuid,
    admin: Uuid,
    member: Uuid,
    guest: Uuid,
}

async fn people(db: &DatabaseConnection) -> People {
    let owner = make_user(db, "owner").await;
    let admin = make_user(db, "admin").await;
    let member = make_user(db, "member").await;
    let guest = make_user(db, "guest").await;
    let space = crate::testkit::make_space(db, owner, "Delegation").await;
    crate::testkit::add_member(db, space, admin, "admin").await;
    crate::testkit::add_member(db, space, member, "member").await;
    crate::testkit::add_member(db, space, guest, "guest").await;
    People {
        space,
        owner,
        admin,
        member,
        guest,
    }
}

#[tokio::test]
async fn a_rank_is_the_highest_role_held() {
    let Some(app) = boot().await else { return };
    let p = people(&app.db).await;
    let stranger = make_user(&app.db, "stranger").await;
    assert_eq!(
        rank_of(&app.db, p.space, p.owner).await.expect("rank"),
        Some(Rank::Owner)
    );
    assert_eq!(
        rank_of(&app.db, p.space, p.admin).await.expect("rank"),
        Some(Rank::Position(100))
    );
    assert_eq!(
        rank_of(&app.db, p.space, p.member).await.expect("rank"),
        Some(Rank::Position(0))
    );
    assert_eq!(
        rank_of(&app.db, p.space, p.guest).await.expect("rank"),
        Some(Rank::Position(-1))
    );
    assert_eq!(
        rank_of(&app.db, p.space, stranger).await.expect("rank"),
        None
    );
    let hr = make_role(
        &app.db,
        p.space,
        "Ressources humaines",
        50,
        &["roles.manage"],
    )
    .await;
    assign(&app.db, p.space, p.member, hr).await;
    assert_eq!(
        rank_of(&app.db, p.space, p.member).await.expect("rank"),
        Some(Rank::Position(50))
    );
}

#[tokio::test]
async fn an_administrator_cannot_manage_administrator() {
    let Some(app) = boot().await else { return };
    let p = people(&app.db).await;
    let administrator = administrator_of(&app.db, p.space).await;
    let accountant = make_role(&app.db, p.space, "Comptable", 40, &["files.manage"]).await;
    assert!(
        ensure_manages_role(&app.db, p.space, p.admin, administrator)
            .await
            .is_err()
    );
    let managed = ensure_manages_role(&app.db, p.space, p.admin, accountant)
        .await
        .expect("manages");
    assert_eq!(managed.name, "Comptable");
    assert_eq!(managed.position, 40);
    // The owner manages every role, Administrator included.
    assert!(
        ensure_manages_role(&app.db, p.space, p.owner, administrator)
            .await
            .is_ok()
    );
    // Without roles.manage, not even a role below one's own.
    let hr = make_role(&app.db, p.space, "Ressources humaines", 50, &[]).await;
    assign(&app.db, p.space, p.member, hr).await;
    assert!(ensure_manages_role(&app.db, p.space, p.member, accountant)
        .await
        .is_err());
    // A role of another space is never managed here.
    let elsewhere = people(&app.db).await;
    let foreign = make_role(&app.db, elsewhere.space, "Ailleurs", 10, &[]).await;
    assert!(ensure_manages_role(&app.db, p.space, p.owner, foreign)
        .await
        .is_err());
}

#[tokio::test]
async fn acting_on_someone_needs_to_outrank_them() {
    let Some(app) = boot().await else { return };
    let p = people(&app.db).await;
    let other_admin = make_user(&app.db, "admin2").await;
    crate::testkit::add_member(&app.db, p.space, other_admin, "admin").await;
    let other_owner = make_user(&app.db, "owner2").await;
    crate::testkit::add_member(&app.db, p.space, other_owner, "owner").await;
    assert!(ensure_acts_on(&app.db, p.space, p.admin, p.member)
        .await
        .is_ok());
    assert!(ensure_acts_on(&app.db, p.space, p.admin, p.guest)
        .await
        .is_ok());
    assert!(ensure_acts_on(&app.db, p.space, p.admin, other_admin)
        .await
        .is_err());
    assert!(ensure_acts_on(&app.db, p.space, p.admin, p.owner)
        .await
        .is_err());
    assert!(ensure_acts_on(&app.db, p.space, p.admin, p.admin)
        .await
        .is_err());
    assert!(ensure_acts_on(&app.db, p.space, p.owner, p.admin)
        .await
        .is_ok());
    assert!(ensure_acts_on(&app.db, p.space, p.owner, other_owner)
        .await
        .is_err());
    assert!(ensure_acts_on(&app.db, p.space, p.member, p.guest)
        .await
        .is_ok());
}

#[tokio::test]
async fn a_refusal_says_why() {
    let Some(app) = boot().await else { return };
    let p = people(&app.db).await;
    let other_admin = make_user(&app.db, "admin2").await;
    crate::testkit::add_member(&app.db, p.space, other_admin, "admin").await;
    let refused = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/spaces/{}/members/{other_admin}", p.space),
            &app.cookie_for(p.admin).await,
        )
        .json(&json!({ "role": "member" }))
        .send()
        .await
        .expect("patch");
    assert_eq!(refused.status(), 403);
    let body: Value = refused.json().await.expect("json");
    assert_eq!(body["error"], "forbidden");
    assert_eq!(body["reason"], "person_above_you");
}

#[tokio::test]
async fn a_custom_role_never_lifts_a_guest_above_the_ceiling() {
    let Some(app) = boot().await else { return };
    let p = people(&app.db).await;
    let names: Vec<&str> = crate::permissions::catalogue::Permission::ALL
        .iter()
        .map(|p| p.name())
        .collect();
    let everything = make_role(&app.db, p.space, "Tout", 60, &names).await;
    assign(&app.db, p.space, p.guest, everything).await;
    let rights = crate::permissions::check::space_rights(&app.db, p.space, p.guest)
        .await
        .expect("rights");
    // GUEST_CEILING is what a guest can never hold; space-wide visibility is dropped for them too.
    assert_eq!(
        rights.intersect(GUEST_CEILING),
        PermissionSet::EMPTY,
        "{:?}",
        rights.to_names()
    );
    assert_eq!(
        rights.intersect(VISIBILITY_DROP),
        PermissionSet::EMPTY,
        "{:?}",
        rights.to_names()
    );
}

#[tokio::test]
async fn the_repair_never_undoes_a_custom_assignment() {
    let Some(app) = boot().await else { return };
    let p = people(&app.db).await;
    let accountant = make_role(&app.db, p.space, "Comptable", 40, &["files.manage"]).await;
    assign(&app.db, p.space, p.member, accountant).await;
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT permissions_convert_space($1)",
            [p.space.into()],
        ))
        .await
        .expect("repair");
    let kept = app
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT count(*)::bigint AS n FROM space_role_assignments WHERE role_id = $1 AND user_id = $2",
            [accountant.into(), p.member.into()],
        ))
        .await
        .expect("query")
        .expect("row")
        .try_get::<i64>("", "n")
        .expect("n");
    assert_eq!(kept, 1);
}
