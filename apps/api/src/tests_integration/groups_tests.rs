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

async fn count(db: &DatabaseConnection, sql: &str, values: Vec<sea_orm::Value>) -> i64 {
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

async fn make_group(db: &DatabaseConnection, space: Uuid, name: &str) -> Uuid {
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

async fn put_in_group(
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

async fn give_role_to_group(
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
    let message = Uuid::new_v4();
    exec(
        db,
        "INSERT INTO messages (id, conversation_id, author_id) \
         SELECT $1, id, $2 FROM conversations LIMIT 1",
        vec![message.into(), owner.into()],
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

    Migrator::down(db, Some(1)).await.expect("down");
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
