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
        // The rules naming a role keep it from being dropped.
        "DELETE FROM permission_overrides WHERE space_id = $1 AND role_id IS NOT NULL",
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

// ---- Loading and checking (Task 4) ----

use crate::permissions::catalogue::Permission;
use crate::permissions::check::{self, Resource};

/// A channel membership with a channel role.
pub(super) async fn join_as(db: &DatabaseConnection, channel_id: Uuid, user_id: Uuid, role: &str) {
    channel_members::ActiveModel {
        channel_id: Set(channel_id),
        user_id: Set(user_id),
        role: Set(role.to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("channel member");
}

async fn sees(db: &DatabaseConnection, space_id: Uuid, user_id: Uuid, channel_id: Uuid) -> bool {
    check::can(
        db,
        space_id,
        user_id,
        Resource::Channel(channel_id),
        Permission::ChannelView,
    )
    .await
    .expect("check")
}

#[tokio::test]
async fn a_member_reads_a_public_channel() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "general", "public").await;
    for (who, expected) in [
        (fx.owner, true),
        (fx.admin, true),
        (fx.member, true),
        (fx.guest, false),
    ] {
        assert_eq!(sees(&app.db, fx.space_id, who, channel).await, expected);
    }
    join_as(&app.db, channel, fx.guest, "member").await;
    assert!(sees(&app.db, fx.space_id, fx.guest, channel).await);
}

#[tokio::test]
async fn an_admin_reserved_channel_refuses_a_member_and_admits_an_admin() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "board", "public").await;
    reserve(&app.db, channel, &["admin"]).await;
    for user in [fx.member, fx.guest] {
        join_as(&app.db, channel, user, "member").await;
    }
    for (who, expected) in [
        (fx.owner, true),
        (fx.admin, true),
        (fx.member, false),
        (fx.guest, false),
    ] {
        assert_eq!(sees(&app.db, fx.space_id, who, channel).await, expected);
    }
    // Private, the same reservation still asks the administrator to join first.
    let private = make_channel(&app.db, fx.space_id, "inner", "private").await;
    reserve(&app.db, private, &["admin"]).await;
    assert!(!sees(&app.db, fx.space_id, fx.admin, private).await);
    join_as(&app.db, private, fx.admin, "member").await;
    assert!(sees(&app.db, fx.space_id, fx.admin, private).await);
    assert!(sees(&app.db, fx.space_id, fx.owner, private).await);
}

#[tokio::test]
async fn a_space_missing_its_system_roles_is_repaired_on_first_check() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM space_roles WHERE space_id = $1",
            [fx.space_id.into()],
        ))
        .await
        .expect("lose the roles");
    let invites = |who| {
        check::can(
            &app.db,
            fx.space_id,
            who,
            Resource::Space,
            Permission::MembersInvite,
        )
    };
    assert!(invites(fx.admin).await.expect("check"));
    assert!(!invites(fx.member).await.expect("check"));
    assert!(check::can(
        &app.db,
        fx.space_id,
        fx.member,
        Resource::Space,
        Permission::ChannelsCreate
    )
    .await
    .expect("check"));
    assert_eq!(system_roles_of(&app.db, fx.space_id).await.len(), 3);
    assert_eq!(administrators(&app.db, fx.space_id).await, vec![fx.admin]);
}

#[tokio::test]
async fn a_resource_of_another_space_grants_nothing() {
    let Some(app) = boot().await else { return };
    let here = ladder(&app.db).await;
    let there = ladder(&app.db).await;
    let channel = make_channel(&app.db, there.space_id, "elsewhere", "public").await;
    let calendar = space_calendar(&app.db, there.space_id, "members").await;
    let folder = Uuid::new_v4();
    files::ActiveModel {
        id: Set(folder),
        space_id: Set(there.space_id),
        name: Set("Ailleurs".to_owned()),
        kind: Set("folder".to_owned()),
        owner_id: Set(Some(here.owner)),
        ..Default::default()
    }
    .insert(&app.db)
    .await
    .expect("folder");
    for resource in [
        Resource::Channel(channel),
        Resource::Calendar(calendar),
        Resource::File(folder),
    ] {
        // Checked in the space they hold, by its owner, and by the file's own author.
        let got = check::effective(&app.db, here.space_id, here.owner, resource)
            .await
            .expect("check");
        assert!(
            got.is_empty(),
            "{resource:?} of another space granted {got:?}"
        );
    }
    // And a member of the other space checked against this one gets nothing either.
    let got = check::effective(&app.db, here.space_id, there.member, Resource::Space)
        .await
        .expect("check");
    assert!(got.is_empty());
}

#[tokio::test]
async fn an_expired_guest_gets_nothing() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "visit", "public").await;
    join_as(&app.db, channel, fx.guest, "member").await;
    let set_expiry = |when: &'static str| {
        app.db.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!(
                "UPDATE space_members SET expires_at = now() {when} WHERE space_id = $1 AND user_id = $2"
            ),
            [fx.space_id.into(), fx.guest.into()],
        ))
    };
    set_expiry("+ interval '1 day'").await.expect("expiry");
    assert!(sees(&app.db, fx.space_id, fx.guest, channel).await);
    set_expiry("- interval '1 minute'").await.expect("expiry");
    assert!(!sees(&app.db, fx.space_id, fx.guest, channel).await);
    for resource in [Resource::Space, Resource::Channel(channel)] {
        let got = check::effective(&app.db, fx.space_id, fx.guest, resource)
            .await
            .expect("check");
        assert!(got.is_empty(), "an expired guest kept {got:?}");
    }
}

#[tokio::test]
async fn bulk_and_single_agree() {
    let Some(app) = boot().await else { return };
    let db = &app.db;
    let fx = ladder(db).await;
    let mut channels = Vec::new();
    for (index, (kind, reservation)) in [
        ("public", &[][..]),
        ("private", &[][..]),
        ("archived", &[][..]),
        ("public", &["admin"][..]),
        ("private", &["admin"][..]),
        ("public", &["member", "guest"][..]),
        ("public", &["guest"][..]),
    ]
    .into_iter()
    .enumerate()
    {
        let channel = make_channel(db, fx.space_id, &format!("c{index}"), kind).await;
        reserve(db, channel, reservation).await;
        channels.push(channel);
    }
    join_as(db, channels[1], fx.member, "owner").await;
    join_as(db, channels[4], fx.admin, "member").await;
    join_as(db, channels[5], fx.guest, "member").await;
    join_as(db, channels[6], fx.member, "admin").await;
    let foreign = ladder(db).await;
    let elsewhere = make_channel(db, foreign.space_id, "elsewhere", "public").await;
    let mut asked = channels.clone();
    asked.push(elsewhere);
    for user in [fx.owner, fx.admin, fx.member, fx.guest] {
        let bulk = check::effective_many(db, fx.space_id, user, &asked)
            .await
            .expect("bulk");
        for channel in &channels {
            let single = check::effective(db, fx.space_id, user, Resource::Channel(*channel))
                .await
                .expect("single");
            assert_eq!(bulk.get(channel).copied().unwrap_or_default(), single);
        }
        assert!(bulk.get(&elsewhere).copied().unwrap_or_default().is_empty());
    }
}

#[tokio::test]
async fn holders_lists_who_reads_a_reserved_channel() {
    let Some(app) = boot().await else { return };
    let db = &app.db;
    let fx = ladder(db).await;
    let open = make_channel(db, fx.space_id, "open", "public").await;
    let board = make_channel(db, fx.space_id, "board", "public").await;
    reserve(db, board, &["admin"]).await;
    for channel in [open, board] {
        join_as(db, channel, fx.guest, "member").await;
    }
    let sorted = |mut ids: Vec<Uuid>| {
        ids.sort();
        ids
    };
    let holders = |channel| {
        check::holders(
            db,
            fx.space_id,
            Resource::Channel(channel),
            Permission::ChannelView,
        )
    };
    assert_eq!(
        sorted(holders(open).await.expect("holders")),
        sorted(vec![fx.owner, fx.admin, fx.member, fx.guest])
    );
    assert_eq!(
        sorted(holders(board).await.expect("holders")),
        sorted(vec![fx.owner, fx.admin])
    );
}

/// "Why may they?" is the same resolution: the trace of an administrator's view of a reserved
/// channel names the Administrator role.
#[tokio::test]
async fn explain_says_which_role_opened_a_reserved_channel() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let board = make_channel(&app.db, fx.space_id, "board", "public").await;
    reserve(&app.db, board, &["admin"]).await;
    let decision = check::explain(&app.db, fx.space_id, fx.admin, Resource::Channel(board))
        .await
        .expect("explain");
    assert!(decision.granted.contains(Permission::ChannelView));
    let admin_role = system_roles_of(&app.db, fx.space_id)
        .await
        .into_iter()
        .find(|role| role.system_key.as_deref() == Some("administrator"))
        .expect("Administrator")
        .id;
    let last = decision
        .trace
        .iter()
        .rev()
        .find(|step| step.permission == Permission::ChannelView)
        .expect("a step about the view");
    assert_eq!(
        last.source,
        crate::permissions::engine::Source::Role(admin_role)
    );
    assert_eq!(last.effect, crate::permissions::engine::Effect::Granted);
}

// ---- Every write of the old model reaches the new one, and is announced (Task 6) ----

/// Watch a socket for `permissions.changed` about a space.
async fn expect_permissions_changed(
    ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
    space_id: Uuid,
) {
    let event = wait_for_type(ws, "permissions.changed").await;
    assert_eq!(event["payload"]["space_id"], space_id.to_string());
}

#[tokio::test]
async fn changing_a_role_writes_both_models() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let owner = app.cookie_for(fx.owner).await;
    let mut watching = app.connect_ws(&app.cookie_for(fx.guest).await).await;
    let (status, _) = set_role(&app, &owner, fx.space_id, fx.member, "admin").await;
    assert_eq!(status, 200);
    assert_eq!(role_of(&app.db, fx.space_id, fx.member).await, "admin");
    let mut both = vec![fx.admin, fx.member];
    both.sort();
    assert_eq!(administrators(&app.db, fx.space_id).await, both);
    expect_permissions_changed(&mut watching, fx.space_id).await;

    let (status, _) = set_role(&app, &owner, fx.space_id, fx.member, "guest").await;
    assert_eq!(status, 200);
    assert_eq!(standing_of(&app.db, fx.space_id, fx.member).await, "guest");
    assert_eq!(administrators(&app.db, fx.space_id).await, vec![fx.admin]);
    expect_permissions_changed(&mut watching, fx.space_id).await;
}

#[tokio::test]
async fn handing_a_space_over_writes_both_models() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let owner = app.cookie_for(fx.owner).await;
    let mut watching = app.connect_ws(&app.cookie_for(fx.member).await).await;
    let (status, _) = set_role(&app, &owner, fx.space_id, fx.admin, "owner").await;
    assert_eq!(status, 200);
    assert_eq!(standing_of(&app.db, fx.space_id, fx.admin).await, "owner");
    assert_eq!(role_of(&app.db, fx.space_id, fx.owner).await, "admin");
    assert_eq!(standing_of(&app.db, fx.space_id, fx.owner).await, "member");
    assert_eq!(administrators(&app.db, fx.space_id).await, vec![fx.owner]);
    expect_permissions_changed(&mut watching, fx.space_id).await;
}

#[tokio::test]
async fn accepting_an_admin_invitation_writes_both_models() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    // Accepting lands the newcomer in the space's default channel.
    let general = make_channel(&app.db, fx.space_id, "general", "public").await;
    spaces::ActiveModel {
        id: Set(fx.space_id),
        default_channel_id: Set(Some(general)),
        ..Default::default()
    }
    .update(&app.db)
    .await
    .expect("default channel");
    let owner = app.cookie_for(fx.owner).await;
    let created = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/spaces/{}/invitations", fx.space_id),
            &owner,
        )
        .json(&json!({ "role": "admin" }))
        .send()
        .await
        .expect("create invitation");
    assert_eq!(created.status(), 201);
    let invitation: Value = created.json().await.expect("json");
    let token = token_of(invitation["url"].as_str().expect("url"));
    let newcomer = make_user(&app.db, "newcomer").await;
    let mut watching = app.connect_ws(&app.cookie_for(fx.member).await).await;
    let accepted = app
        .req(
            reqwest::Method::POST,
            &format!("/api/v1/invitations/{token}/accept"),
            &app.cookie_for(newcomer).await,
        )
        .send()
        .await
        .expect("accept");
    assert_eq!(accepted.status(), 200);
    assert_eq!(role_of(&app.db, fx.space_id, newcomer).await, "admin");
    assert_eq!(standing_of(&app.db, fx.space_id, newcomer).await, "member");
    assert!(administrators(&app.db, fx.space_id)
        .await
        .contains(&newcomer));
    expect_permissions_changed(&mut watching, fx.space_id).await;
}

#[tokio::test]
async fn reserving_a_channel_writes_both_models() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "board", "public").await;
    let owner = app.cookie_for(fx.owner).await;
    let mut watching = app.connect_ws(&app.cookie_for(fx.member).await).await;
    let reserve_to = |roles: Value| {
        app.req(
            reqwest::Method::PATCH,
            &format!("/api/v1/channels/{channel}"),
            &owner,
        )
        .json(&json!({ "allowed_roles": roles }))
        .send()
    };
    let reserved = reserve_to(json!(["admin"])).await.expect("reserve");
    assert_eq!(reserved.status(), 200);
    assert_eq!(
        rules_on(
            &app.db,
            fx.space_id,
            permission_overrides::Column::ChannelId,
            channel
        )
        .await,
        vec![
            rule("administrator", &["channel.view"], &[]),
            rule("guests", &[], &["channel.view"]),
            rule("members", &[], &["channel.view"]),
        ]
    );
    expect_permissions_changed(&mut watching, fx.space_id).await;
    // An empty list lifts the reservation (an absent one changes nothing).
    let cleared = reserve_to(json!([])).await.expect("clear");
    assert_eq!(cleared.status(), 200);
    assert!(rules_on(
        &app.db,
        fx.space_id,
        permission_overrides::Column::ChannelId,
        channel
    )
    .await
    .is_empty());
    expect_permissions_changed(&mut watching, fx.space_id).await;
}

#[tokio::test]
async fn restricting_calendar_writing_writes_both_models() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let calendar = space_calendar(&app.db, fx.space_id, "members").await;
    let owner = app.cookie_for(fx.owner).await;
    let mut watching = app.connect_ws(&app.cookie_for(fx.member).await).await;
    let restricted = app
        .req(
            reqwest::Method::PATCH,
            &format!("/api/v1/calendars/{calendar}"),
            &owner,
        )
        .json(&json!({ "write_access": "admins" }))
        .send()
        .await
        .expect("restrict");
    assert_eq!(restricted.status(), 200);
    assert_eq!(
        rules_on(
            &app.db,
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
    expect_permissions_changed(&mut watching, fx.space_id).await;
}

#[tokio::test]
async fn an_import_writes_both_models() {
    let Some(app) = boot().await else { return };
    let fx = seed(&app.db).await;
    let imported = import_two_spaces(&app, fx.alice).await;
    for space_id in [imported.first_space, imported.second_space] {
        let members = space_members::Entity::find()
            .filter(space_members::Column::SpaceId.eq(space_id))
            .all(&app.db)
            .await
            .expect("members");
        assert!(!members.is_empty());
        let mut admins = Vec::new();
        for member in members {
            let expected = match member.role.as_str() {
                "owner" => "owner",
                "guest" => "guest",
                _ => "member",
            };
            assert_eq!(
                standing_of(&app.db, space_id, member.user_id).await,
                expected
            );
            if member.role == "admin" {
                admins.push(member.user_id);
            }
        }
        admins.sort();
        assert_eq!(administrators(&app.db, space_id).await, admins);
    }
    std::fs::remove_dir_all(&imported.dir).ok();
}

// ---- Messaging on the engine (Task 7) ----

/// A channel's people are listed to whoever reads the channel, and to nobody else: a member
/// reserved out of it and a guest who was never added to it used to get the list all the same.
#[tokio::test]
async fn a_channel_lists_its_people_only_to_its_readers() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let open = make_channel(&app.db, fx.space_id, "open", "public").await;
    let board = make_channel(&app.db, fx.space_id, "board", "public").await;
    reserve(&app.db, board, &["admin"]).await;
    let list = |channel: Uuid, who: Uuid| {
        let app = &app;
        async move {
            status_of(
                app,
                reqwest::Method::GET,
                &format!("/api/v1/channels/{channel}/members"),
                &app.cookie_for(who).await,
            )
            .await
        }
    };
    assert_eq!(list(open, fx.member).await, 200);
    assert_eq!(list(board, fx.admin).await, 200);
    assert_eq!(list(board, fx.owner).await, 200);
    assert_eq!(list(board, fx.member).await, 403);
    assert_eq!(list(open, fx.guest).await, 403);
    join_as(&app.db, open, fx.guest, "member").await;
    assert_eq!(list(open, fx.guest).await, 200);
}

// ---- Audiences and lists in bulk (Task 10) ----

/// The sidebar of a large space is resolved in a fixed number of queries, whatever its size.
#[tokio::test]
async fn listing_a_space_resolves_in_bulk() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "WITH made AS ( \
                 INSERT INTO conversations (id, space_id, kind, created_at) \
                 SELECT gen_random_uuid(), $1, 'channel', now() FROM generate_series(1, 300) \
                 RETURNING id) \
             INSERT INTO channels (id, space_id, name, type) \
             SELECT id, $1, 'bulk-' || row_number() OVER (ORDER BY id), 'public' FROM made",
            [fx.space_id.into()],
        ))
        .await
        .expect("300 channels");
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO channel_role_access (channel_id, role) \
             SELECT id, 'admin' FROM channels WHERE space_id = $1 ORDER BY name LIMIT 60",
            [fx.space_id.into()],
        ))
        .await
        .expect("60 reserved");
    let cookie = app.cookie_for(fx.member).await;
    let before = crate::permissions::load::queries_issued(fx.space_id);
    let started = std::time::Instant::now();
    let listed = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/channels", fx.space_id),
            &cookie,
        )
        .send()
        .await
        .expect("list");
    let elapsed = started.elapsed();
    assert_eq!(listed.status(), 200);
    let listed: Value = listed.json().await.expect("json");
    assert_eq!(listed.as_array().map(Vec::len), Some(240));
    let issued = crate::permissions::load::queries_issued(fx.space_id) - before;
    eprintln!("sidebar of 300 channels: {elapsed:?}, {issued} permission queries");
    assert!(issued <= 5, "the listing made {issued} permission queries");
}

// ---- What the clients are told they may do (Task 11) ----

fn names_of(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|names| {
            names
                .iter()
                .filter_map(|name| name.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn a_listing_says_what_the_caller_may_do() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "general", "public").await;
    let get = |path: String, who: Uuid| {
        let app = &app;
        async move {
            let response = app
                .req(reqwest::Method::GET, &path, &app.cookie_for(who).await)
                .send()
                .await
                .expect("get");
            assert_eq!(response.status(), 200, "{path}");
            response.json::<Value>().await.expect("json")
        }
    };

    // The space, at space level.
    for (who, invites) in [(fx.admin, true), (fx.member, false)] {
        let spaces = get("/api/v1/me/spaces".to_owned(), who).await;
        let space = spaces
            .as_array()
            .and_then(|spaces| {
                spaces
                    .iter()
                    .find(|space| space["id"] == fx.space_id.to_string())
            })
            .expect("the space")
            .clone();
        let held = names_of(&space["my_permissions"]);
        assert_eq!(held.contains(&"members.invite".to_owned()), invites);
        assert!(held.contains(&"channels.create".to_owned()));
    }

    // Each channel of the sidebar.
    for (who, manages) in [(fx.admin, true), (fx.member, false)] {
        let listed = get(format!("/api/v1/spaces/{}/channels", fx.space_id), who).await;
        let entry = listed
            .as_array()
            .and_then(|channels| channels.iter().find(|c| c["id"] == channel.to_string()))
            .expect("the channel")
            .clone();
        let held = names_of(&entry["my_permissions"]);
        assert_eq!(held.contains(&"channel.manage".to_owned()), manages);
        assert!(held.contains(&"channel.view".to_owned()));
        assert!(
            !held.contains(&"members.invite".to_owned()),
            "only the channel's family"
        );
    }

    // Each entry of a folder listing: managing a file follows authorship.
    let mut ids = Vec::new();
    for author in [fx.member, fx.owner] {
        let id = Uuid::new_v4();
        files::ActiveModel {
            id: Set(id),
            space_id: Set(fx.space_id),
            name: Set(format!("note-{}.txt", id.simple())),
            kind: Set("file".to_owned()),
            owner_id: Set(Some(author)),
            ..Default::default()
        }
        .insert(&app.db)
        .await
        .expect("file");
        ids.push(id);
    }
    let listing = get(format!("/api/v1/spaces/{}/files", fx.space_id), fx.member).await;
    let manage_of = |id: Uuid| {
        let entry = listing["entries"]
            .as_array()
            .and_then(|entries| entries.iter().find(|e| e["id"] == id.to_string()))
            .expect("the entry");
        names_of(&entry["my_permissions"]).contains(&"files.manage".to_owned())
    };
    assert!(manage_of(ids[0]), "their own file");
    assert!(!manage_of(ids[1]), "someone else's");
}

/// A whole listing's rights in bulk are what each entry gets on its own.
#[tokio::test]
async fn bulk_file_rights_agree_with_single() {
    let Some(app) = boot().await else { return };
    let db = &app.db;
    let fx = ladder(db).await;
    let folder = Uuid::new_v4();
    files::ActiveModel {
        id: Set(folder),
        space_id: Set(fx.space_id),
        name: Set("Dossier".to_owned()),
        kind: Set("folder".to_owned()),
        owner_id: Set(Some(fx.admin)),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("folder");
    let channel = make_channel(db, fx.space_id, "private", "private").await;
    join_as(db, channel, fx.guest, "member").await;
    let mut ids = vec![folder];
    for (author, parent, conversation) in [
        (fx.member, Some(folder), None),
        (fx.guest, Some(folder), None),
        (fx.owner, None, None),
        (fx.guest, None, Some(channel)),
    ] {
        let id = Uuid::new_v4();
        files::ActiveModel {
            id: Set(id),
            space_id: Set(fx.space_id),
            name: Set(format!("f-{}.txt", id.simple())),
            kind: Set("file".to_owned()),
            owner_id: Set(Some(author)),
            parent_folder_id: Set(parent),
            conversation_id: Set(conversation),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("file");
        ids.push(id);
    }
    // The paths that are not the space tree: a direct message, a file a guest reaches through a
    // message, a private channel the member is not in.
    let dm = Uuid::new_v4();
    conversations::ActiveModel {
        id: Set(dm),
        space_id: Set(fx.space_id),
        kind: Set("direct".to_owned()),
        created_at: Set(OffsetDateTime::now_utc()),
    }
    .insert(db)
    .await
    .expect("dm conversation");
    dm_conversations::ActiveModel {
        id: Set(dm),
        space_id: Set(fx.space_id),
        is_group: Set(false),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("dm");
    for person in [fx.member, fx.guest] {
        dm_participants::ActiveModel {
            dm_id: Set(dm),
            user_id: Set(person),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("participant");
    }
    let hall = make_channel(db, fx.space_id, "hall", "public").await;
    join_as(db, hall, fx.guest, "member").await;
    let secret = make_channel(db, fx.space_id, "secret", "private").await;
    for (author, conversation, posted_in) in [
        (fx.member, Some(dm), None),
        (fx.admin, None, Some(hall)),
        (fx.admin, Some(secret), None),
        (fx.guest, None, None),
    ] {
        let id = Uuid::new_v4();
        files::ActiveModel {
            id: Set(id),
            space_id: Set(fx.space_id),
            name: Set(format!("p-{}.txt", id.simple())),
            kind: Set("file".to_owned()),
            owner_id: Set(Some(author)),
            conversation_id: Set(conversation),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("file");
        if let Some(channel) = posted_in {
            let message = Uuid::new_v4();
            messages::ActiveModel {
                id: Set(message),
                conversation_id: Set(channel),
                author_id: Set(Some(author)),
                kind: Set("message".to_owned()),
                body: Set("ci-joint".to_owned()),
                created_at: Set(OffsetDateTime::now_utc()),
                ..Default::default()
            }
            .insert(db)
            .await
            .expect("message");
            message_attachments::ActiveModel {
                message_id: Set(message),
                file_id: Set(id),
                position: Set(0),
                ..Default::default()
            }
            .insert(db)
            .await
            .expect("attachment");
        }
        ids.push(id);
    }
    for who in [fx.owner, fx.admin, fx.member, fx.guest] {
        let bulk = check::files_effective(db, fx.space_id, who, &ids)
            .await
            .expect("bulk");
        for id in &ids {
            let single = check::effective(db, fx.space_id, who, Resource::File(*id))
                .await
                .expect("single");
            assert_eq!(
                bulk.get(id).copied().unwrap_or_default(),
                single,
                "file {id} for {who}"
            );
        }
    }
}

// ---- Final review fixes ----

/// Losing only the Administrator role (a manual delete, a partial restore) must not quietly turn
/// the administrators into plain members.
#[tokio::test]
async fn a_space_missing_only_its_administrator_role_is_repaired() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM space_roles WHERE space_id = $1 AND system_key = 'administrator'",
            [fx.space_id.into()],
        ))
        .await
        .expect("lose the Administrator role");
    assert!(check::can(
        &app.db,
        fx.space_id,
        fx.admin,
        Resource::Space,
        Permission::MembersInvite
    )
    .await
    .expect("check"));
    assert_eq!(administrators(&app.db, fx.space_id).await, vec![fx.admin]);
}

/// A role of the space's own carrying a system role's name never stops the system role from being
/// recreated.
#[tokio::test]
async fn a_role_named_like_a_system_role_does_not_stop_the_repair() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    for statement in [
        "DELETE FROM space_roles WHERE space_id = $1 AND system_key = 'administrator'",
        "INSERT INTO space_roles (space_id, name, position, permissions) \
         VALUES ($1, 'Administrator', 50, '{}')",
    ] {
        app.db
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                statement,
                [fx.space_id.into()],
            ))
            .await
            .expect("set up");
    }
    assert!(check::can(
        &app.db,
        fx.space_id,
        fx.admin,
        Resource::Space,
        Permission::MembersInvite
    )
    .await
    .expect("check"));
    assert_eq!(system_roles_of(&app.db, fx.space_id).await.len(), 3);
}

/// Whoever may add and remove a channel's people sees who they are, even when the channel is
/// reserved away from them.
#[tokio::test]
async fn a_moderator_reserved_out_still_lists_the_people_they_manage() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let floor = make_channel(&app.db, fx.space_id, "floor", "public").await;
    reserve(&app.db, floor, &["member"]).await;
    let status = status_of(
        &app,
        reqwest::Method::GET,
        &format!("/api/v1/channels/{floor}/members"),
        &app.cookie_for(fx.admin).await,
    )
    .await;
    assert_eq!(status, 200);
}

/// Who a channel's message goes to is worked out from the channel's members, not from the whole
/// space: a large space must not cost every push.
#[tokio::test]
async fn a_channel_push_reads_only_the_channel_members() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "WITH made AS ( \
                 INSERT INTO users (id, email, display_name, status, mfa_enforced, is_bot) \
                 SELECT gen_random_uuid(), 'crowd-' || gen_random_uuid() || '@example.test', \
                        'Crowd', 'active', false, false \
                 FROM generate_series(1, 200) RETURNING id) \
             INSERT INTO space_members (space_id, user_id, role) SELECT $1, id, 'member' FROM made",
            [fx.space_id.into()],
        ))
        .await
        .expect("200 more members");
    let channel = make_channel(&app.db, fx.space_id, "small", "public").await;
    for user in [fx.admin, fx.member] {
        join_as(&app.db, channel, user, "member").await;
    }
    let before = crate::permissions::load::people_read(fx.space_id);
    let mut audience = crate::messaging::authz::channel_audience(&app.db, channel)
        .await
        .expect("audience");
    audience.sort();
    let mut expected = vec![fx.admin, fx.member];
    expected.sort();
    assert_eq!(audience, expected);
    let read = crate::permissions::load::people_read(fx.space_id) - before;
    assert!(read <= 5, "the audience read {read} people");
}

/// A listing of conversation files, and of files a guest reaches through messages, is resolved in
/// a fixed number of queries.
#[tokio::test]
async fn a_listing_of_conversation_files_resolves_in_bulk() {
    let Some(app) = boot().await else { return };
    let db = &app.db;
    let fx = ladder(db).await;
    let private = make_channel(db, fx.space_id, "projet", "private").await;
    let public = make_channel(db, fx.space_id, "annonces", "public").await;
    for (channel, user) in [
        (private, fx.member),
        (private, fx.admin),
        (public, fx.guest),
        (public, fx.admin),
    ] {
        join_as(db, channel, user, "member").await;
    }
    // Thirty files carried by the private channel, twenty tree files posted in the public one.
    for (channel, count, carried) in [(private, 30, true), (public, 20, false)] {
        app.db
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "WITH f AS ( \
                     INSERT INTO files (id, space_id, owner_id, name, kind, conversation_id) \
                     SELECT gen_random_uuid(), $1, $2, 'doc-' || gen_random_uuid() || '.txt', \
                            'file', CASE WHEN $5 THEN $3::uuid END \
                     FROM generate_series(1, $4) RETURNING id), \
                 m AS ( \
                     INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) \
                     SELECT gen_random_uuid(), $3, $2, 'message', 'ci-joint', now() FROM f \
                     RETURNING id), \
                 pairs AS ( \
                     SELECT f.id AS file_id, m.id AS message_id \
                     FROM (SELECT id, row_number() OVER () AS n FROM f) f \
                     JOIN (SELECT id, row_number() OVER () AS n FROM m) m USING (n)) \
                 INSERT INTO message_attachments (message_id, file_id, position) \
                 SELECT message_id, file_id, 0 FROM pairs",
                [
                    fx.space_id.into(),
                    fx.admin.into(),
                    channel.into(),
                    count.into(),
                    carried.into(),
                ],
            ))
            .await
            .expect("files and their messages");
    }
    for (who, expected) in [(fx.member, 30), (fx.guest, 20)] {
        let before = crate::permissions::load::queries_issued(fx.space_id);
        let response = app
            .req(
                reqwest::Method::GET,
                &format!("/api/v1/spaces/{}/files/shared", fx.space_id),
                &app.cookie_for(who).await,
            )
            .send()
            .await
            .expect("shared");
        assert_eq!(response.status(), 200);
        let listed: Value = response.json().await.expect("json");
        let entries = listed.as_array().expect("entries");
        assert_eq!(entries.len(), expected);
        for entry in entries {
            let held = names_of(&entry["file"]["my_permissions"]);
            assert!(held.contains(&"files.view".to_owned()), "{entry}");
        }
        let issued = crate::permissions::load::queries_issued(fx.space_id) - before;
        assert!(issued <= 15, "the listing made {issued} permission queries");
    }
}

#[tokio::test]
async fn announce_only_tells_the_chosen_people_alone() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let mut chosen = app.connect_ws(&app.cookie_for(fx.member).await).await;
    let mut other = app.connect_ws(&app.cookie_for(fx.admin).await).await;
    crate::permissions::changed::announce_only(&app.state, fx.space_id, &[fx.member]).await;
    expect_permissions_changed(&mut chosen, fx.space_id).await;
    super::group_routes_tests::expect_no_permissions_changed(&mut other).await;
}
