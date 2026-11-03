//! The permission foundation against a real database: today's roles converted, the new model kept
//! in step with every write of the old one, and the system roles every space starts with. Same
//! harness as the parent module, same skip rule.

use super::*;

use crate::entities::{permission_overrides, space_role_assignments, space_roles};
use crate::permissions::catalogue::PermissionSet;
use crate::permissions::system_roles::{ADMINISTRATOR, GUESTS_BASE, MEMBERS_BASE};

/// A space with one person on each rung of today's ladder: owner, admin, member, guest.
pub(super) struct Ladder {
    pub space_id: Uuid,
    pub owner: Uuid,
    pub admin: Uuid,
    pub member: Uuid,
    pub guest: Uuid,
}

pub(super) async fn ladder(db: &DatabaseConnection) -> Ladder {
    let space_id = Uuid::new_v4();
    spaces::ActiveModel {
        id: Set(space_id),
        name: Set("Ladder".to_owned()),
        slug: Set(format!("ladder-{}", space_id.simple())),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("space");
    let mut ids = Vec::new();
    for role in ["owner", "admin", "member", "guest"] {
        let user = make_user(db, role).await;
        space_members::ActiveModel {
            space_id: Set(space_id),
            user_id: Set(user),
            role: Set(role.to_owned()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("space member");
        ids.push(user);
    }
    Ladder {
        space_id,
        owner: ids[0],
        admin: ids[1],
        member: ids[2],
        guest: ids[3],
    }
}

/// Reserve a channel to some roles the way today's code does: one `channel_role_access` row each.
pub(super) async fn reserve(db: &DatabaseConnection, channel_id: Uuid, roles: &[&str]) {
    for role in roles {
        db.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO channel_role_access (channel_id, role) VALUES ($1, $2)",
            [channel_id.into(), (*role).into()],
        ))
        .await
        .expect("reserve");
    }
}

/// A space calendar, with who may write in it.
pub(super) async fn space_calendar(db: &DatabaseConnection, space_id: Uuid, write: &str) -> Uuid {
    let id = Uuid::new_v4();
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO calendars (id, space_id, name, color, write_access) \
         VALUES ($1, $2, 'Planning', 'sky', $3)",
        [id.into(), space_id.into(), write.into()],
    ))
    .await
    .expect("calendar");
    id
}

async fn standing_of(db: &DatabaseConnection, space_id: Uuid, user_id: Uuid) -> String {
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT standing FROM space_members WHERE space_id = $1 AND user_id = $2",
        [space_id.into(), user_id.into()],
    ))
    .await
    .expect("standing")
    .expect("member row")
    .try_get::<String>("", "standing")
    .expect("standing column")
}

async fn system_roles_of(db: &DatabaseConnection, space_id: Uuid) -> Vec<space_roles::Model> {
    let mut roles = space_roles::Entity::find()
        .filter(space_roles::Column::SpaceId.eq(space_id))
        .filter(space_roles::Column::SystemKey.is_not_null())
        .all(db)
        .await
        .expect("roles");
    roles.sort_by_key(|role| role.system_key.clone());
    roles
}

/// Who holds the Administrator role in a space.
async fn administrators(db: &DatabaseConnection, space_id: Uuid) -> Vec<Uuid> {
    let roles = system_roles_of(db, space_id).await;
    let admin = roles
        .iter()
        .find(|role| role.system_key.as_deref() == Some("administrator"))
        .expect("an Administrator role");
    let mut ids: Vec<Uuid> = space_role_assignments::Entity::find()
        .filter(space_role_assignments::Column::RoleId.eq(admin.id))
        .all(db)
        .await
        .expect("assignments")
        .into_iter()
        .map(|assignment| assignment.user_id)
        .collect();
    ids.sort();
    ids
}

/// The rules on a resource, as (system role, allow, deny), sorted.
async fn rules_on(
    db: &DatabaseConnection,
    space_id: Uuid,
    resource: permission_overrides::Column,
    id: Uuid,
) -> Vec<(String, Vec<String>, Vec<String>)> {
    let roles = system_roles_of(db, space_id).await;
    let mut rules: Vec<(String, Vec<String>, Vec<String>)> = permission_overrides::Entity::find()
        .filter(resource.eq(id))
        .all(db)
        .await
        .expect("rules")
        .into_iter()
        .map(|rule| {
            let key = roles
                .iter()
                .find(|role| Some(role.id) == rule.role_id)
                .and_then(|role| role.system_key.clone())
                .unwrap_or_else(|| "?".to_owned());
            (key, rule.allow, rule.deny)
        })
        .collect();
    rules.sort();
    rules
}

fn rule(key: &str, allow: &[&str], deny: &[&str]) -> (String, Vec<String>, Vec<String>) {
    let names = |list: &[&str]| list.iter().map(|name| (*name).to_owned()).collect();
    (key.to_owned(), names(allow), names(deny))
}

/// What the migration does to the data it finds: the standing out of the role, the Administrator
/// role for every administrator, and a reservation or a calendar closed to members as rules. The
/// derived rows are wiped first so the conversion runs on the old model alone, as it did on the
/// day it shipped, and it runs twice to show it is safe to repeat.
#[tokio::test]
async fn the_migration_converts_todays_roles() {
    let Some(app) = boot().await else { return };
    let db = &app.db;
    let fx = ladder(db).await;
    let admins_only = make_channel(db, fx.space_id, "board", "private").await;
    reserve(db, admins_only, &["admin"]).await;
    let no_admins = make_channel(db, fx.space_id, "floor", "public").await;
    reserve(db, no_admins, &["member", "guest"]).await;
    let calendar = space_calendar(db, fx.space_id, "admins").await;

    for statement in [
        "DELETE FROM space_roles WHERE space_id = $1",
        "UPDATE space_members SET standing = 'member', expires_at = NULL WHERE space_id = $1",
    ] {
        db.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            statement,
            [fx.space_id.into()],
        ))
        .await
        .expect("back to the old model");
    }
    assert!(system_roles_of(db, fx.space_id).await.is_empty());

    for _ in 0..2 {
        ruchoir_migration::m20261104_000001_permissions_foundation::convert_space(db, fx.space_id)
            .await
            .expect("convert");

        assert_eq!(standing_of(db, fx.space_id, fx.owner).await, "owner");
        assert_eq!(standing_of(db, fx.space_id, fx.admin).await, "member");
        assert_eq!(standing_of(db, fx.space_id, fx.member).await, "member");
        assert_eq!(standing_of(db, fx.space_id, fx.guest).await, "guest");

        let keys: Vec<Option<String>> = system_roles_of(db, fx.space_id)
            .await
            .into_iter()
            .map(|role| role.system_key)
            .collect();
        assert_eq!(
            keys,
            vec![
                Some("administrator".to_owned()),
                Some("guests".to_owned()),
                Some("members".to_owned())
            ]
        );
        assert_eq!(administrators(db, fx.space_id).await, vec![fx.admin]);

        assert_eq!(
            rules_on(
                db,
                fx.space_id,
                permission_overrides::Column::ChannelId,
                admins_only
            )
            .await,
            vec![
                rule("administrator", &["channel.view"], &[]),
                rule("guests", &[], &["channel.view"]),
                rule("members", &[], &["channel.view"]),
            ]
        );
        assert_eq!(
            rules_on(
                db,
                fx.space_id,
                permission_overrides::Column::ChannelId,
                no_admins
            )
            .await,
            vec![rule("administrator", &[], &["channel.view"])]
        );
        assert_eq!(
            rules_on(
                db,
                fx.space_id,
                permission_overrides::Column::CalendarId,
                calendar
            )
            .await,
            vec![
                rule("administrator", &["calendar.write"], &[]),
                rule("members", &[], &["calendar.write"]),
            ]
        );
    }
}

/// The old columns stay the ones the code writes (and the ones a previous image would write after a
/// rollback), so every write of them reaches the new model at once, whoever makes it.
#[tokio::test]
async fn the_new_model_follows_every_legacy_write() {
    let Some(app) = boot().await else { return };
    let db = &app.db;
    let fx = ladder(db).await;
    assert_eq!(administrators(db, fx.space_id).await, vec![fx.admin]);

    set_space_role(db, fx.space_id, fx.member, "admin").await;
    let mut both = vec![fx.admin, fx.member];
    both.sort();
    assert_eq!(administrators(db, fx.space_id).await, both);
    set_space_role(db, fx.space_id, fx.member, "guest").await;
    assert_eq!(standing_of(db, fx.space_id, fx.member).await, "guest");
    assert_eq!(administrators(db, fx.space_id).await, vec![fx.admin]);
    set_space_role(db, fx.space_id, fx.admin, "owner").await;
    assert_eq!(standing_of(db, fx.space_id, fx.admin).await, "owner");
    assert!(administrators(db, fx.space_id).await.is_empty());

    let channel = make_channel(db, fx.space_id, "board", "public").await;
    reserve(db, channel, &["admin", "member"]).await;
    assert_eq!(
        rules_on(
            db,
            fx.space_id,
            permission_overrides::Column::ChannelId,
            channel
        )
        .await,
        vec![
            rule("administrator", &["channel.view"], &[]),
            rule("guests", &[], &["channel.view"]),
        ]
    );
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "DELETE FROM channel_role_access WHERE channel_id = $1",
        [channel.into()],
    ))
    .await
    .expect("lift the reservation");
    assert!(rules_on(
        db,
        fx.space_id,
        permission_overrides::Column::ChannelId,
        channel
    )
    .await
    .is_empty());

    let calendar = space_calendar(db, fx.space_id, "members").await;
    assert!(rules_on(
        db,
        fx.space_id,
        permission_overrides::Column::CalendarId,
        calendar
    )
    .await
    .is_empty());
    for (write, expected) in [
        (
            "admins",
            vec![
                rule("administrator", &["calendar.write"], &[]),
                rule("members", &[], &["calendar.write"]),
            ],
        ),
        ("members", vec![]),
    ] {
        db.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE calendars SET write_access = $2 WHERE id = $1",
            [calendar.into(), write.into()],
        ))
        .await
        .expect("calendar setting");
        assert_eq!(
            rules_on(
                db,
                fx.space_id,
                permission_overrides::Column::CalendarId,
                calendar
            )
            .await,
            expected
        );
    }

    // Deleting what a rule is about takes the rule with it, and nothing refuses the deletion.
    reserve(db, channel, &["admin"]).await;
    channels::Entity::delete_by_id(channel)
        .exec(db)
        .await
        .expect("delete the channel");
    assert!(rules_on(
        db,
        fx.space_id,
        permission_overrides::Column::ChannelId,
        channel
    )
    .await
    .is_empty());
}

/// The system roles hold exactly what the engine's constants say: a space created by the database
/// alone and the code agree on what a member, a guest and an administrator start with.
#[tokio::test]
async fn the_system_roles_hold_the_constants() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let roles = system_roles_of(&app.db, fx.space_id).await;
    let held = |key: &str| {
        let role = roles
            .iter()
            .find(|role| role.system_key.as_deref() == Some(key))
            .expect("system role");
        PermissionSet::from_names(&role.permissions)
    };
    assert_eq!(held("administrator"), ADMINISTRATOR);
    assert_eq!(held("members"), MEMBERS_BASE);
    assert_eq!(held("guests"), GUESTS_BASE);
    let positions: Vec<i32> = roles.iter().map(|role| role.position).collect();
    assert_eq!(positions, vec![100, -1, 0]);
}

#[tokio::test]
async fn a_new_space_starts_with_its_system_roles() {
    let Some(app) = boot().await else { return };
    let founder = make_user(&app.db, "founder").await;
    let cookie = app.cookie_for(founder).await;
    let created = app
        .req(reqwest::Method::POST, "/api/v1/spaces", &cookie)
        .json(&json!({ "name": format!("Roles {}", Uuid::new_v4().simple()) }))
        .send()
        .await
        .expect("create space");
    assert_eq!(created.status(), 201);
    let space: Value = created.json().await.expect("json");
    let space_id: Uuid = space["id"].as_str().expect("id").parse().expect("uuid");
    assert_eq!(system_roles_of(&app.db, space_id).await.len(), 3);
    assert_eq!(standing_of(&app.db, space_id, founder).await, "owner");
    assert!(administrators(&app.db, space_id).await.is_empty());
}

#[tokio::test]
async fn an_imported_space_starts_with_its_system_roles() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let imported = import_two_spaces(&app, fx.alice).await;
    for space_id in [imported.first_space, imported.second_space] {
        assert_eq!(system_roles_of(&app.db, space_id).await.len(), 3);
    }
    assert_eq!(
        standing_of(&app.db, imported.first_space, imported.insider).await,
        "member"
    );
    std::fs::remove_dir_all(&imported.dir).ok();
}
