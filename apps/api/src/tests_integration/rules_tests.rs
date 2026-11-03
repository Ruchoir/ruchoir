//! The rules' new targets against a real database: a group, and the readers of a channel. Exactly
//! one target per rule, one rule per resource and target, audiences on files only, what goes with
//! what, the audit check, the migration's round trip, and what the loader reads.

use super::*;

use super::delegation_tests::{assign, make_role};
use super::groups_tests::{count, give_role_to_group, make_group, put_in_group};
use super::permissions_tests::{ladder, space_calendar};

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

async fn make_file(db: &DatabaseConnection, space: Uuid, owner: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    exec(
        db,
        "INSERT INTO files (id, space_id, owner_id, name, kind) VALUES ($1, $2, $3, $4, 'file')",
        vec![id.into(), space.into(), owner.into(), name.into()],
    )
    .await
    .expect("file");
    id
}

/// One rule row: the resource column and the target columns are given by name, the rest is
/// `file.view`-ish and irrelevant.
async fn rule(
    db: &DatabaseConnection,
    space: Uuid,
    resource: (&str, Uuid),
    target: &[(&str, Uuid)],
) -> Result<(), String> {
    let mut columns = vec!["space_id", resource.0];
    let mut values: Vec<sea_orm::Value> = vec![space.into(), resource.1.into()];
    for (column, id) in target {
        columns.push(column);
        values.push((*id).into());
    }
    let marks: Vec<String> = (1..=columns.len()).map(|n| format!("${n}")).collect();
    exec(
        db,
        &format!(
            "INSERT INTO permission_overrides ({}) VALUES ({})",
            columns.join(", "),
            marks.join(", ")
        ),
        values,
    )
    .await
}

#[tokio::test]
async fn a_rule_has_exactly_one_target() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "cible", "public").await;
    let audience = make_channel(&app.db, fx.space_id, "lecteurs", "public").await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "a.txt").await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    let role = make_role(&app.db, fx.space_id, "Role", 10, &["files.view"]).await;

    // None.
    assert!(rule(&app.db, fx.space_id, ("file_id", file), &[])
        .await
        .is_err());
    // Two.
    assert!(rule(
        &app.db,
        fx.space_id,
        ("channel_id", channel),
        &[("group_id", group), ("user_id", fx.member)]
    )
    .await
    .is_err());
    assert!(rule(
        &app.db,
        fx.space_id,
        ("file_id", file),
        &[("group_id", group), ("audience_channel_id", audience)]
    )
    .await
    .is_err());
    assert!(rule(
        &app.db,
        fx.space_id,
        ("file_id", file),
        &[("role_id", role), ("group_id", group)]
    )
    .await
    .is_err());
    // One of each kind is fine.
    rule(
        &app.db,
        fx.space_id,
        ("channel_id", channel),
        &[("group_id", group)],
    )
    .await
    .expect("group");
    rule(
        &app.db,
        fx.space_id,
        ("file_id", file),
        &[("audience_channel_id", audience)],
    )
    .await
    .expect("audience");
}

#[tokio::test]
async fn one_rule_per_resource_and_target() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "cible", "public").await;
    let audience = make_channel(&app.db, fx.space_id, "lecteurs", "public").await;
    let other = make_channel(&app.db, fx.space_id, "autre", "public").await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "a.txt").await;
    let calendar = space_calendar(&app.db, fx.space_id, "members").await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    let second = make_group(&app.db, fx.space_id, "Autres").await;

    for resource in [
        ("channel_id", channel),
        ("file_id", file),
        ("calendar_id", calendar),
    ] {
        rule(&app.db, fx.space_id, resource, &[("group_id", group)])
            .await
            .expect("first");
        assert!(
            rule(&app.db, fx.space_id, resource, &[("group_id", group)])
                .await
                .is_err(),
            "{} twice for the same group",
            resource.0
        );
        rule(&app.db, fx.space_id, resource, &[("group_id", second)])
            .await
            .expect("another group is another rule");
    }
    rule(
        &app.db,
        fx.space_id,
        ("file_id", file),
        &[("audience_channel_id", audience)],
    )
    .await
    .expect("first audience");
    assert!(
        rule(
            &app.db,
            fx.space_id,
            ("file_id", file),
            &[("audience_channel_id", audience)]
        )
        .await
        .is_err(),
        "the same audience twice"
    );
    rule(
        &app.db,
        fx.space_id,
        ("file_id", file),
        &[("audience_channel_id", other)],
    )
    .await
    .expect("another audience");
}

#[tokio::test]
async fn audience_rules_exist_on_files_only() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "cible", "public").await;
    let audience = make_channel(&app.db, fx.space_id, "lecteurs", "public").await;
    let calendar = space_calendar(&app.db, fx.space_id, "members").await;
    for resource in [("channel_id", channel), ("calendar_id", calendar)] {
        assert!(
            rule(
                &app.db,
                fx.space_id,
                resource,
                &[("audience_channel_id", audience)]
            )
            .await
            .is_err(),
            "{} with an audience",
            resource.0
        );
    }
}

#[tokio::test]
async fn a_rule_cannot_name_another_spaces_group_or_channel() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let elsewhere = ladder(&app.db).await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "a.txt").await;
    let foreign_group = make_group(&app.db, elsewhere.space_id, "Ailleurs").await;
    let foreign_channel = make_channel(&app.db, elsewhere.space_id, "ailleurs", "public").await;
    assert!(rule(
        &app.db,
        fx.space_id,
        ("file_id", file),
        &[("group_id", foreign_group)]
    )
    .await
    .is_err());
    assert!(rule(
        &app.db,
        fx.space_id,
        ("file_id", file),
        &[("audience_channel_id", foreign_channel)]
    )
    .await
    .is_err());
}

#[tokio::test]
async fn a_group_named_by_a_rule_cannot_be_dropped_by_sql() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "cible", "public").await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    rule(
        &app.db,
        fx.space_id,
        ("channel_id", channel),
        &[("group_id", group)],
    )
    .await
    .expect("rule");
    assert!(
        exec(
            &app.db,
            "DELETE FROM space_groups WHERE id = $1",
            vec![group.into()]
        )
        .await
        .is_err(),
        "a deny never goes with its target"
    );
    // Once the rule is gone, so can the group.
    exec(
        &app.db,
        "DELETE FROM permission_overrides WHERE group_id = $1",
        vec![group.into()],
    )
    .await
    .expect("rule removed");
    exec(
        &app.db,
        "DELETE FROM space_groups WHERE id = $1",
        vec![group.into()],
    )
    .await
    .expect("group dropped");

    // A whole space still goes, rules and groups together.
    let group = make_group(&app.db, fx.space_id, "Encore").await;
    rule(
        &app.db,
        fx.space_id,
        ("channel_id", channel),
        &[("group_id", group)],
    )
    .await
    .expect("rule again");
    exec(
        &app.db,
        "DELETE FROM spaces WHERE id = $1",
        vec![fx.space_id.into()],
    )
    .await
    .expect("the space goes with its groups and rules");
}

#[tokio::test]
async fn a_rule_goes_with_its_resource() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "cible", "public").await;
    let audience = make_channel(&app.db, fx.space_id, "lecteurs", "public").await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "a.txt").await;
    let calendar = space_calendar(&app.db, fx.space_id, "members").await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    for resource in [
        ("channel_id", channel),
        ("file_id", file),
        ("calendar_id", calendar),
    ] {
        rule(&app.db, fx.space_id, resource, &[("group_id", group)])
            .await
            .expect("rule");
    }
    rule(
        &app.db,
        fx.space_id,
        ("file_id", file),
        &[("audience_channel_id", audience)],
    )
    .await
    .expect("audience rule");
    let remaining = |column: &'static str, id: Uuid| {
        let db = app.db.clone();
        async move {
            count(
                &db,
                &format!("SELECT count(*) AS n FROM permission_overrides WHERE {column} = $1"),
                vec![id.into()],
            )
            .await
        }
    };
    // The audience channel going takes the rule that names it, and only that one.
    exec(
        &app.db,
        "DELETE FROM channels WHERE id = $1",
        vec![audience.into()],
    )
    .await
    .expect("audience channel");
    assert_eq!(remaining("audience_channel_id", audience).await, 0);
    assert_eq!(remaining("file_id", file).await, 1);
    for (column, id, table) in [
        ("channel_id", channel, "channels"),
        ("file_id", file, "files"),
        ("calendar_id", calendar, "calendars"),
    ] {
        exec(
            &app.db,
            &format!("DELETE FROM {table} WHERE id = $1"),
            vec![id.into()],
        )
        .await
        .expect("resource");
        assert_eq!(remaining(column, id).await, 0, "{column}");
    }
    assert_eq!(remaining("group_id", group).await, 0);
}

#[tokio::test]
async fn the_audit_check_accepts_file() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    for kind in ["file", "group", "member"] {
        exec(
            &app.db,
            "INSERT INTO space_audit_log (space_id, actor_id, action, target_kind) VALUES ($1, $2, 'x', $3)",
            vec![fx.space_id.into(), fx.owner.into(), kind.into()],
        )
        .await
        .unwrap_or_else(|e| panic!("{kind}: {e}"));
    }
    assert!(exec(
        &app.db,
        "INSERT INTO space_audit_log (space_id, actor_id, action, target_kind) VALUES ($1, $2, 'x', 'nothing')",
        vec![fx.space_id.into(), fx.owner.into()],
    )
    .await
    .is_err());
}

/// `down` then `up` on a database of its own: a rule naming a group or an audience is dropped
/// (the previous version cannot hold it), the others stay, and the audit log is never touched.
#[tokio::test]
async fn the_rules_migration_round_trips() {
    let Some(scratch) = ScratchDb::create().await else {
        return;
    };
    let db = &scratch.db;
    let columns = "SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'permission_overrides' AND column_name IN ('group_id', 'audience_channel_id')";
    assert_eq!(count(db, columns, vec![]).await, 2);

    let owner = make_user(db, "owner").await;
    let space = crate::testkit::make_space(db, owner, "Trip").await;
    let channel = make_channel(db, space, "cible", "public").await;
    let audience = make_channel(db, space, "lecteurs", "public").await;
    let file = make_file(db, space, owner, "a.txt").await;
    let group = make_group(db, space, "Equipe").await;
    let role = make_role(db, space, "Role", 10, &["files.view"]).await;
    rule(db, space, ("channel_id", channel), &[("group_id", group)])
        .await
        .expect("group rule");
    rule(
        db,
        space,
        ("file_id", file),
        &[("audience_channel_id", audience)],
    )
    .await
    .expect("audience rule");
    rule(db, space, ("channel_id", channel), &[("role_id", role)])
        .await
        .expect("role rule");
    exec(
        db,
        "INSERT INTO space_audit_log (space_id, actor_id, action, target_kind) VALUES ($1, $2, 'file.share', 'file')",
        vec![space.into(), owner.into()],
    )
    .await
    .expect("file audit");

    Migrator::down(db, Some(1)).await.expect("down");
    assert_eq!(count(db, columns, vec![]).await, 0);
    assert_eq!(
        count(
            db,
            "SELECT count(*) AS n FROM permission_overrides WHERE space_id = $1 AND role_id = $2",
            vec![space.into(), role.into()],
        )
        .await,
        1,
        "the role rule stays"
    );
    assert_eq!(
        count(
            db,
            "SELECT count(*) AS n FROM permission_overrides WHERE space_id = $1 AND channel_id = $2 AND role_id IS NULL",
            vec![space.into(), channel.into()],
        )
        .await,
        0,
        "the group rule goes"
    );
    assert_eq!(
        count(
            db,
            "SELECT count(*) AS n FROM space_audit_log WHERE space_id = $1 AND target_kind = 'file'",
            vec![space.into()],
        )
        .await,
        1,
        "the audit entry is untouched"
    );
    // The old shape holds again: a rule still needs exactly one of role or person.
    assert!(rule(db, space, ("file_id", file), &[]).await.is_err());

    Migrator::up(db, None).await.expect("up again");
    assert_eq!(count(db, columns, vec![]).await, 2);
    rule(db, space, ("channel_id", channel), &[("group_id", group)])
        .await
        .expect("group rule again");
    scratch.drop_it().await;
}

#[tokio::test]
async fn the_loader_reads_groups_and_carriers() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let role = make_role(&app.db, fx.space_id, "Archiviste", 30, &["files.manage"]).await;
    let direct = make_role(&app.db, fx.space_id, "Direct", 20, &["files.view"]).await;
    let carrier = make_group(&app.db, fx.space_id, "Archives").await;
    let plain = make_group(&app.db, fx.space_id, "Sans role").await;
    give_role_to_group(&app.db, carrier, fx.space_id, role)
        .await
        .expect("carried");
    put_in_group(&app.db, carrier, fx.space_id, fx.member, false).await;
    put_in_group(&app.db, plain, fx.space_id, fx.member, false).await;
    assign(&app.db, fx.space_id, fx.member, direct).await;
    put_in_group(&app.db, plain, fx.space_id, fx.admin, true).await;

    let people = crate::permissions::load::people_groups_for_test(&app.db, fx.space_id)
        .await
        .expect("people");
    let (groups, role_groups) = &people[&fx.member];
    let mut expected = vec![carrier, plain];
    expected.sort();
    let mut got = groups.clone();
    got.sort();
    assert_eq!(got, expected);
    assert_eq!(role_groups.get(&role), Some(&vec![carrier]));
    assert!(
        !role_groups.contains_key(&direct),
        "a role held directly is not held through a group"
    );
    let (groups, role_groups) = &people[&fx.admin];
    assert_eq!(groups, &vec![plain]);
    assert!(role_groups.is_empty());
    let (groups, role_groups) = &people[&fx.guest];
    assert!(groups.is_empty() && role_groups.is_empty());
}
