//! The groups tables and the holdings view against a real database: cascades, the same-space
//! foreign keys, what the view lists, the widened checks, and the migration's round trip.

use super::*;

use super::delegation_tests::{assign, make_role};

async fn exec(
    db: &DatabaseConnection,
    sql: &str,
    values: Vec<sea_orm::Value>,
) -> Result<(), String> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub(super) async fn count(db: &DatabaseConnection, sql: &str, values: Vec<sea_orm::Value>) -> i64 {
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .await
    .expect("query")
    .expect("row")
    .try_get("", "n")
    .expect("n")
}

pub(super) async fn make_group(db: &DatabaseConnection, space: Uuid, name: &str) -> Uuid {
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO space_groups (space_id, name) VALUES ($1, $2) RETURNING id",
        [space.into(), name.into()],
    ))
    .await
    .expect("group")
    .expect("row")
    .try_get("", "id")
    .expect("id")
}

pub(super) async fn put_in_group(
    db: &DatabaseConnection,
    group: Uuid,
    space: Uuid,
    user: Uuid,
    manager: bool,
) {
    exec(
        db,
        "INSERT INTO space_group_members (group_id, space_id, user_id, is_manager) VALUES ($1, $2, $3, $4)",
        vec![group.into(), space.into(), user.into(), manager.into()],
    )
    .await
    .expect("group member");
}

pub(super) async fn give_role_to_group(
    db: &DatabaseConnection,
    group: Uuid,
    space: Uuid,
    role: Uuid,
) -> Result<(), String> {
    exec(
        db,
        "INSERT INTO space_group_roles (group_id, space_id, role_id) VALUES ($1, $2, $3)",
        vec![group.into(), space.into(), role.into()],
    )
    .await
}

#[tokio::test]
async fn a_group_lives_and_dies_with_its_space() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Groups").await;
    let group = make_group(&app.db, space, "Comptabilite").await;
    put_in_group(&app.db, group, space, owner, true).await;
    let role = make_role(&app.db, space, "Comptable", 40, &["files.manage"]).await;
    give_role_to_group(&app.db, group, space, role)
        .await
        .expect("role");

    // Names are unique per space, whatever the case.
    let twice = exec(
        &app.db,
        "INSERT INTO space_groups (space_id, name) VALUES ($1, 'COMPTABILITE')",
        vec![space.into()],
    )
    .await;
    assert!(twice.is_err(), "citext unique name");
    // A name of blanks is no name.
    let blank = exec(
        &app.db,
        "INSERT INTO space_groups (space_id, name) VALUES ($1, '   ')",
        vec![space.into()],
    )
    .await;
    assert!(blank.is_err(), "whitespace-only name");
    // A description is capped at 280 characters.
    let long = exec(
        &app.db,
        "INSERT INTO space_groups (space_id, name, description) VALUES ($1, 'Long', $2)",
        vec![space.into(), "x".repeat(281).into()],
    )
    .await;
    assert!(long.is_err());
    let source = exec(
        &app.db,
        "INSERT INTO space_groups (space_id, name, source) VALUES ($1, 'Odd', 'other')",
        vec![space.into()],
    )
    .await;
    assert!(source.is_err());
    // An external id is unique per space, when present.
    exec(
        &app.db,
        "UPDATE space_groups SET source = 'directory', external_id = 'ext-1' WHERE id = $1",
        vec![group.into()],
    )
    .await
    .expect("external id");
    let dup = exec(
        &app.db,
        "INSERT INTO space_groups (space_id, name, external_id) VALUES ($1, 'Other', 'ext-1')",
        vec![space.into()],
    )
    .await;
    assert!(dup.is_err(), "external id unique per space");

    exec(
        &app.db,
        "DELETE FROM spaces WHERE id = $1",
        vec![space.into()],
    )
    .await
    .expect("delete space");
    for table in ["space_groups", "space_group_members", "space_group_roles"] {
        let n = count(
            &app.db,
            &format!("SELECT count(*) AS n FROM {table} WHERE space_id = $1"),
            vec![space.into()],
        )
        .await;
        assert_eq!(n, 0, "{table} left rows");
    }
}

#[tokio::test]
async fn leaving_the_space_leaves_its_groups() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let member = make_user(&app.db, "member").await;
    let space = crate::testkit::make_space(&app.db, owner, "Leaving").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    let group = make_group(&app.db, space, "Team").await;
    put_in_group(&app.db, group, space, member, true).await;

    // Only a member of the space can be in one of its groups.
    let outsider = make_user(&app.db, "outsider").await;
    let refused = exec(
        &app.db,
        "INSERT INTO space_group_members (group_id, space_id, user_id) VALUES ($1, $2, $3)",
        vec![group.into(), space.into(), outsider.into()],
    )
    .await;
    assert!(refused.is_err(), "a non-member cannot join a group");

    exec(
        &app.db,
        "DELETE FROM space_members WHERE space_id = $1 AND user_id = $2",
        vec![space.into(), member.into()],
    )
    .await
    .expect("leave");
    let n = count(
        &app.db,
        "SELECT count(*) AS n FROM space_group_members WHERE group_id = $1",
        vec![group.into()],
    )
    .await;
    assert_eq!(n, 0, "membership and manager rows go with the member");
    let groups = count(
        &app.db,
        "SELECT count(*) AS n FROM space_groups WHERE id = $1",
        vec![group.into()],
    )
    .await;
    assert_eq!(groups, 1, "the group stays");
}

#[tokio::test]
async fn a_group_cannot_carry_another_spaces_role() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Mine").await;
    let other = crate::testkit::make_space(&app.db, owner, "Theirs").await;
    let group = make_group(&app.db, space, "Team").await;
    let foreign = make_role(&app.db, other, "Foreign", 40, &["files.manage"]).await;
    assert!(give_role_to_group(&app.db, group, space, foreign)
        .await
        .is_err());
    // A group of another space is refused too.
    let own = make_role(&app.db, space, "Own", 40, &["files.manage"]).await;
    assert!(give_role_to_group(&app.db, group, other, own)
        .await
        .is_err());
    give_role_to_group(&app.db, group, space, own)
        .await
        .expect("own role");

    // Deleting the role drops the link.
    exec(
        &app.db,
        "DELETE FROM space_roles WHERE id = $1",
        vec![own.into()],
    )
    .await
    .expect("delete role");
    let n = count(
        &app.db,
        "SELECT count(*) AS n FROM space_group_roles WHERE group_id = $1",
        vec![group.into()],
    )
    .await;
    assert_eq!(n, 0);
}

#[tokio::test]
async fn holdings_list_direct_and_group_roles() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let member = make_user(&app.db, "member").await;
    let space = crate::testkit::make_space(&app.db, owner, "Holdings").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    let direct = make_role(&app.db, space, "Direct", 40, &["files.manage"]).await;
    let through = make_role(&app.db, space, "Through", 30, &["files.manage"]).await;
    assign(&app.db, space, member, direct).await;
    let group = make_group(&app.db, space, "Team").await;
    put_in_group(&app.db, group, space, member, false).await;
    give_role_to_group(&app.db, group, space, through)
        .await
        .expect("role");

    // The same role held directly and through a group is two rows: the view does not deduplicate.
    let both = make_role(&app.db, space, "Both", 20, &["files.manage"]).await;
    assign(&app.db, space, member, both).await;
    give_role_to_group(&app.db, group, space, both)
        .await
        .expect("role");

    let rows = app
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT role_id, group_id FROM space_role_holdings WHERE space_id = $1 AND user_id = $2",
            [space.into(), member.into()],
        ))
        .await
        .expect("holdings");
    let mut seen: Vec<(Uuid, Option<Uuid>)> = rows
        .iter()
        .map(|r| {
            (
                r.try_get("", "role_id").unwrap(),
                r.try_get("", "group_id").unwrap(),
            )
        })
        .collect();
    seen.sort();
    // @members is implicit (no assignment row), so it is not a holding.
    let mut expected = vec![
        (direct, None),
        (through, Some(group)),
        (both, None),
        (both, Some(group)),
    ];
    expected.sort();
    assert_eq!(seen, expected);
}

#[tokio::test]
async fn the_audit_and_mention_checks_accept_group() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Checks").await;
    exec(
        &app.db,
        "INSERT INTO space_audit_log (space_id, actor_id, action, target_kind) VALUES ($1, $2, 'group.create', 'group')",
        vec![space.into(), owner.into()],
    )
    .await
    .expect("audit group");
    let bad = exec(
        &app.db,
        "INSERT INTO space_audit_log (space_id, actor_id, action, target_kind) VALUES ($1, $2, 'x', 'nonsense')",
        vec![space.into(), owner.into()],
    )
    .await;
    assert!(bad.is_err(), "the audit check still refuses unknown kinds");

    let defs = app
        .db
        .query_all_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint \
             WHERE contype = 'c' AND conrelid IN ('space_audit_log'::regclass, 'message_mentions'::regclass)"
                .to_owned(),
        ))
        .await
        .expect("constraints");
    let defs: Vec<(String, String)> = defs
        .iter()
        .map(|r| {
            (
                r.try_get("", "conname").unwrap(),
                r.try_get("", "def").unwrap(),
            )
        })
        .collect();
    assert_eq!(
        defs.iter()
            .filter(|(_, d)| d.contains("mention_type"))
            .count(),
        1
    );
    assert_eq!(
        defs.iter()
            .filter(|(_, d)| d.contains("target_kind"))
            .count(),
        1
    );
    let mention = defs
        .iter()
        .find(|(_, d)| d.contains("mention_type"))
        .expect("mention check");
    assert!(mention.1.contains("'group'"), "{mention:?}");
    assert_eq!(mention.0, "message_mentions_mention_type_check");
    let audit = defs
        .iter()
        .find(|(_, d)| d.contains("target_kind"))
        .expect("audit check");
    assert!(audit.1.contains("'group'"), "{audit:?}");
    assert_eq!(audit.0, "space_audit_log_target_kind_check");
}

/// `down` then `up` on a database of its own, with data: a mention of a group becomes a mention
/// of a person, the audit log is never touched, and the groups come back as they were.
#[tokio::test]
async fn the_groups_migration_round_trips() {
    let Some(scratch) = ScratchDb::create().await else {
        return;
    };
    let db = &scratch.db;
    let tables = "SELECT count(*) AS n FROM information_schema.tables WHERE table_name IN ('space_groups', 'space_group_members', 'space_group_roles', 'space_role_holdings')";
    let wide = "SELECT count(*) AS n FROM pg_constraint WHERE contype = 'c' AND pg_get_constraintdef(oid) LIKE '%''group''%'";
    assert_eq!(count(db, tables, vec![]).await, 4);
    assert_eq!(count(db, wide, vec![]).await, 2);

    let owner = make_user(db, "owner").await;
    let space = crate::testkit::make_space(db, owner, "Trip").await;
    // The message goes in the conversation of this space's own default channel, made just above.
    let message = Uuid::new_v4();
    exec(
        db,
        "INSERT INTO messages (id, conversation_id, author_id) \
         SELECT $1, default_channel_id, $2 FROM spaces WHERE id = $3",
        vec![message.into(), owner.into(), space.into()],
    )
    .await
    .expect("message");
    exec(
        db,
        "INSERT INTO message_mentions (message_id, mentioned_user_id, mention_type) VALUES ($1, $2, 'group')",
        vec![message.into(), owner.into()],
    )
    .await
    .expect("group mention");
    exec(
        db,
        "INSERT INTO space_audit_log (space_id, actor_id, action, target_kind) VALUES ($1, $2, 'group.create', 'group')",
        vec![space.into(), owner.into()],
    )
    .await
    .expect("group audit");

    Migrator::down(db, Some(2)).await.expect("down");
    assert_eq!(count(db, tables, vec![]).await, 0);
    assert_eq!(
        count(
            db,
            "SELECT count(*) AS n FROM message_mentions WHERE message_id = $1 AND mention_type = 'user'",
            vec![message.into()],
        )
        .await,
        1,
        "the mention stays, by name"
    );
    assert_eq!(
        count(
            db,
            "SELECT count(*) AS n FROM space_audit_log WHERE space_id = $1 AND action = 'group.create' AND target_kind = 'group'",
            vec![space.into()],
        )
        .await,
        1,
        "the audit entry is untouched"
    );
    assert_eq!(
        count(db, wide, vec![]).await,
        1,
        "only the audit check stays wide; mentions are narrow again"
    );

    Migrator::up(db, None).await.expect("up again");
    assert_eq!(count(db, tables, vec![]).await, 4);
    assert_eq!(count(db, wide, vec![]).await, 2);
    scratch.drop_it().await;
}

async fn administrator_role(db: &DatabaseConnection, space: Uuid) -> Uuid {
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

#[tokio::test]
async fn a_role_carried_by_a_group_grants_its_permissions() {
    use crate::permissions::catalogue::Permission;
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let member = make_user(&app.db, "member").await;
    let space = crate::testkit::make_space(&app.db, owner, "Carried").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    let before = crate::permissions::check::space_rights(&app.db, space, member)
        .await
        .expect("rights");
    assert!(!before.contains(Permission::FilesTrashPurge));

    let role = make_role(&app.db, space, "Archiviste", 30, &["files.trash.purge"]).await;
    let group = make_group(&app.db, space, "Archives").await;
    give_role_to_group(&app.db, group, space, role)
        .await
        .expect("role");
    put_in_group(&app.db, group, space, member, false).await;
    let granted = crate::permissions::check::space_rights(&app.db, space, member)
        .await
        .expect("rights");
    assert!(
        granted.contains(Permission::FilesTrashPurge),
        "in the group"
    );

    exec(
        &app.db,
        "DELETE FROM space_group_members WHERE group_id = $1 AND user_id = $2",
        vec![group.into(), member.into()],
    )
    .await
    .expect("leave");
    let refused = crate::permissions::check::space_rights(&app.db, space, member)
        .await
        .expect("rights");
    assert!(
        !refused.contains(Permission::FilesTrashPurge),
        "left the group"
    );
}

#[tokio::test]
async fn a_role_carried_by_a_group_counts_for_the_rank() {
    use crate::permissions::delegation::{ensure_acts_on, rank_of, Rank};
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let member = make_user(&app.db, "member").await;
    let other = make_user(&app.db, "other").await;
    let space = crate::testkit::make_space(&app.db, owner, "Rank").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    crate::testkit::add_member(&app.db, space, other, "member").await;
    let role = make_role(&app.db, space, "Cheffe", 50, &["roles.manage"]).await;
    let group = make_group(&app.db, space, "Direction").await;
    give_role_to_group(&app.db, group, space, role)
        .await
        .expect("role");
    put_in_group(&app.db, group, space, member, false).await;
    assert_eq!(
        rank_of(&app.db, space, member).await.expect("rank"),
        Some(Rank::Position(50))
    );
    // The same rank is what the member list reads.
    let loaded = crate::permissions::roles::MemberRoles::load(&app.db, space, member)
        .await
        .expect("load");
    assert!(loaded.manageable(other), "outranks a plain member");
    assert!(!loaded.manageable(owner));
    assert!(ensure_acts_on(&app.db, space, member, other).await.is_ok());
    assert!(loaded.role_ids(member).is_empty(), "role_ids stays direct");
    assert_eq!(loaded.group_ids(member), vec![group]);
    assert!(loaded.group_ids(other).is_empty());
}

#[tokio::test]
async fn a_role_held_twice_is_counted_once() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let member = make_user(&app.db, "member").await;
    let space = crate::testkit::make_space(&app.db, owner, "Twice").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    let role = make_role(&app.db, space, "Comptable", 40, &["files.manage"]).await;
    assign(&app.db, space, member, role).await;
    let (g1, g2) = (
        make_group(&app.db, space, "Un").await,
        make_group(&app.db, space, "Deux").await,
    );
    for g in [g1, g2] {
        give_role_to_group(&app.db, g, space, role)
            .await
            .expect("role");
        put_in_group(&app.db, g, space, member, false).await;
    }
    let roles = crate::permissions::roles::roles_of(&app.db, space, owner)
        .await
        .expect("roles");
    let holders = roles.iter().find(|r| r.id == role).expect("role").holders;
    assert_eq!(holders, 1, "directly and through two groups, one person");
    // And the rights are loaded once, not three times.
    let loaded = crate::permissions::roles::MemberRoles::load(&app.db, space, owner)
        .await
        .expect("load");
    assert_eq!(loaded.role_ids(member), vec![role]);
    assert_eq!(loaded.group_ids(member).len(), 2);
}

#[tokio::test]
async fn a_guest_in_a_group_stays_a_guest() {
    use crate::permissions::catalogue::PermissionSet;
    use crate::permissions::delegation::{ensure_acts_on, rank_of, Rank};
    use crate::permissions::system_roles::{GUEST_CEILING, VISIBILITY_DROP};
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let admin = make_user(&app.db, "admin").await;
    let guest = make_user(&app.db, "guest").await;
    let space = crate::testkit::make_space(&app.db, owner, "Guests").await;
    crate::testkit::add_member(&app.db, space, admin, "admin").await;
    crate::testkit::add_member(&app.db, space, guest, "guest").await;
    let group = make_group(&app.db, space, "Pouvoir").await;
    let administrator = administrator_role(&app.db, space).await;
    give_role_to_group(&app.db, group, space, administrator)
        .await
        .expect("role");
    put_in_group(&app.db, group, space, guest, false).await;

    let rights = crate::permissions::check::space_rights(&app.db, space, guest)
        .await
        .expect("rights");
    assert_eq!(rights.intersect(GUEST_CEILING), PermissionSet::EMPTY);
    assert_eq!(rights.intersect(VISIBILITY_DROP), PermissionSet::EMPTY);
    // Clamped, not emptied: what the guests' base grants is still theirs.
    assert!(
        rights.contains(crate::permissions::catalogue::Permission::DmStart),
        "{:?}",
        rights.to_names()
    );
    assert_eq!(
        rank_of(&app.db, space, guest).await.expect("rank"),
        Some(Rank::Position(-1))
    );
    let loaded = crate::permissions::roles::MemberRoles::load(&app.db, space, admin)
        .await
        .expect("load");
    assert!(loaded.manageable(guest));
    assert!(ensure_acts_on(&app.db, space, admin, guest).await.is_ok());

    // The same for a guest holding a custom role directly.
    let custom = make_role(&app.db, space, "Haut", 60, &["roles.manage"]).await;
    assign(&app.db, space, guest, custom).await;
    assert_eq!(
        rank_of(&app.db, space, guest).await.expect("rank"),
        Some(Rank::Position(-1))
    );
}

async fn legacy_role_and_assignments(
    db: &DatabaseConnection,
    space: Uuid,
    user: Uuid,
) -> (String, i64) {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT m.role AS role, (SELECT count(*) FROM space_role_assignments a \
                WHERE a.space_id = m.space_id AND a.user_id = m.user_id)::bigint AS n \
               FROM space_members m WHERE m.space_id = $1 AND m.user_id = $2",
            [space.into(), user.into()],
        ))
        .await
        .expect("query")
        .expect("row");
    (
        row.try_get("", "role").expect("role"),
        row.try_get("", "n").expect("n"),
    )
}

#[tokio::test]
async fn administrator_through_a_group_leaves_the_legacy_column_alone() {
    use crate::permissions::catalogue::Permission;
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let member = make_user(&app.db, "member").await;
    let space = crate::testkit::make_space(&app.db, owner, "Drift").await;
    crate::testkit::add_member(&app.db, space, member, "member").await;
    let group = make_group(&app.db, space, "Direction").await;
    let administrator = administrator_role(&app.db, space).await;
    give_role_to_group(&app.db, group, space, administrator)
        .await
        .expect("role");
    put_in_group(&app.db, group, space, member, false).await;

    let rights = crate::permissions::check::space_rights(&app.db, space, member)
        .await
        .expect("rights");
    assert!(
        rights.contains(Permission::RolesManage),
        "carried to Administrator"
    );
    assert_eq!(
        legacy_role_and_assignments(&app.db, space, member).await,
        ("member".to_owned(), 0),
        "no legacy write, no repair"
    );
}

#[tokio::test]
async fn a_legacy_admin_is_still_repaired_when_a_group_also_carries_administrator() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let admin = make_user(&app.db, "admin").await;
    let space = crate::testkit::make_space(&app.db, owner, "Drift").await;
    crate::testkit::add_member(&app.db, space, admin, "admin").await;
    let administrator = administrator_role(&app.db, space).await;
    exec(
        &app.db,
        "DELETE FROM space_role_assignments WHERE space_id = $1 AND user_id = $2 AND role_id = $3",
        vec![space.into(), admin.into(), administrator.into()],
    )
    .await
    .expect("drift");
    let group = make_group(&app.db, space, "Direction").await;
    give_role_to_group(&app.db, group, space, administrator)
        .await
        .expect("role");
    put_in_group(&app.db, group, space, admin, false).await;
    assert_eq!(
        legacy_role_and_assignments(&app.db, space, admin).await,
        ("admin".to_owned(), 0),
        "drifted: legacy admin, no direct assignment"
    );

    crate::permissions::check::space_rights(&app.db, space, admin)
        .await
        .expect("rights");
    assert_eq!(
        legacy_role_and_assignments(&app.db, space, admin).await,
        ("admin".to_owned(), 1),
        "the direct assignment is created"
    );
}

#[tokio::test]
async fn groups_of_loads_groups_with_people_and_roles() {
    use crate::permissions::groups::{group, groups_of, GroupSource};
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let guest = make_user(&app.db, "guest").await;
    let space = crate::testkit::make_space(&app.db, owner, "Loading").await;
    let other = crate::testkit::make_space(&app.db, owner, "Elsewhere").await;
    crate::testkit::add_member(&app.db, space, guest, "guest").await;
    let b = make_group(&app.db, space, "Bravo").await;
    let a = make_group(&app.db, space, "alpha").await;
    let foreign = make_group(&app.db, other, "Foreign").await;
    put_in_group(&app.db, a, space, owner, true).await;
    put_in_group(&app.db, a, space, guest, false).await;
    let role = make_role(&app.db, space, "Comptable", 40, &["files.manage"]).await;
    give_role_to_group(&app.db, a, space, role)
        .await
        .expect("role");
    exec(
        &app.db,
        "UPDATE space_groups SET source = 'directory', description = 'from ldap' WHERE id = $1",
        vec![b.into()],
    )
    .await
    .expect("source");

    let all = groups_of(&app.db, space).await.expect("groups");
    assert_eq!(
        all.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
        ["alpha", "Bravo"],
        "by name, case-insensitively, and only this space's"
    );
    assert_eq!(all[0].members.len(), 2);
    let m = |u| all[0].members.iter().find(|m| m.user_id == u).unwrap();
    assert!(m(owner).is_manager && !m(owner).guest);
    assert!(!m(guest).is_manager && m(guest).guest);
    assert_eq!(all[0].roles.len(), 1);
    assert_eq!(all[0].roles[0].id, role);
    assert_eq!(all[0].roles[0].position, 40);
    assert_eq!(all[1].source, GroupSource::Directory);
    assert_eq!(all[1].description.as_deref(), Some("from ldap"));
    assert!(all[1].members.is_empty() && all[1].roles.is_empty());

    let one = group(&app.db, space, a).await.expect("one").expect("some");
    assert_eq!(one.members.len(), 2);
    assert!(group(&app.db, space, foreign).await.expect("q").is_none());
    assert!(group(&app.db, other, a).await.expect("q").is_none());
}
