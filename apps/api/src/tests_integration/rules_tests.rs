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
async fn a_role_named_by_a_rule_cannot_be_dropped_by_sql() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "cible", "public").await;
    let role = make_role(&app.db, fx.space_id, "Relecteur", 10, &["files.view"]).await;
    rule(
        &app.db,
        fx.space_id,
        ("channel_id", channel),
        &[("role_id", role)],
    )
    .await
    .expect("rule");
    assert!(
        exec(
            &app.db,
            "DELETE FROM space_roles WHERE id = $1",
            vec![role.into()]
        )
        .await
        .is_err(),
        "a deny aimed at a role never goes with it"
    );
    exec(
        &app.db,
        "DELETE FROM permission_overrides WHERE role_id = $1",
        vec![role.into()],
    )
    .await
    .expect("rule removed");
    exec(
        &app.db,
        "DELETE FROM space_roles WHERE id = $1",
        vec![role.into()],
    )
    .await
    .expect("role dropped");

    // A whole space still goes, roles and rules together.
    let again = make_role(&app.db, fx.space_id, "Encore", 11, &["files.view"]).await;
    rule(
        &app.db,
        fx.space_id,
        ("channel_id", channel),
        &[("role_id", again)],
    )
    .await
    .expect("rule again");
    exec(
        &app.db,
        "DELETE FROM spaces WHERE id = $1",
        vec![fx.space_id.into()],
    )
    .await
    .expect("the space goes with its roles and rules");
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

    // Back to just before the rules, whatever was added after them.
    let after_rules = Migrator::get_applied_migrations(db)
        .await
        .expect("applied")
        .iter()
        .rev()
        .take_while(|m| m.name() != "m20261106_000001_space_groups")
        .count();
    Migrator::down(db, Some(after_rules as u32))
        .await
        .expect("down");
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

// ---- The engine over the new targets (Task 2) ----

use crate::permissions::catalogue::Permission;
use crate::permissions::check::{self, Resource};

use super::permissions_tests::{join_as, reserve};

/// A rule with its allow and deny lists.
async fn grant(
    db: &DatabaseConnection,
    space: Uuid,
    resource: (&str, Uuid),
    target: (&str, Uuid),
    allow: &[&str],
    deny: &[&str],
) {
    let allow: Vec<String> = allow.iter().map(|p| (*p).to_owned()).collect();
    let deny: Vec<String> = deny.iter().map(|p| (*p).to_owned()).collect();
    exec(
        db,
        &format!(
            "INSERT INTO permission_overrides (space_id, {}, {}, allow, deny) VALUES ($1, $2, $3, $4, $5)",
            resource.0, target.0
        ),
        vec![
            space.into(),
            resource.1.into(),
            target.1.into(),
            allow.into(),
            deny.into(),
        ],
    )
    .await
    .expect("rule");
}

async fn add_member(db: &DatabaseConnection, space: Uuid, name: &str) -> Uuid {
    let user = make_user(db, name).await;
    space_members::ActiveModel {
        space_id: Set(space),
        user_id: Set(user),
        role: Set("member".to_owned()),
        ..Default::default()
    }
    .insert(db)
    .await
    .expect("space member");
    user
}

async fn system_role(db: &DatabaseConnection, space: Uuid, key: &str) -> Uuid {
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT id FROM space_roles WHERE space_id = $1 AND system_key = $2",
        [space.into(), key.into()],
    ))
    .await
    .expect("query")
    .expect("system role")
    .try_get("", "id")
    .expect("id")
}

async fn holds(
    db: &DatabaseConnection,
    space: Uuid,
    user: Uuid,
    resource: Resource,
    permission: Permission,
) -> bool {
    check::can(db, space, user, resource, permission)
        .await
        .expect("check")
}

#[tokio::test]
async fn a_group_rule_applies_to_its_members_only() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let other = add_member(&app.db, fx.space_id, "autre").await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    put_in_group(&app.db, group, fx.space_id, fx.member, false).await;
    put_in_group(&app.db, group, fx.space_id, fx.guest, false).await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "a.txt").await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    grant(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("group_id", group),
        &["files.public_link"],
        &[],
    )
    .await;
    grant(
        &app.db,
        fx.space_id,
        ("channel_id", channel),
        ("group_id", group),
        &["channel.manage"],
        &[],
    )
    .await;
    let link = Permission::FilesPublicLink;
    let manage = Permission::ChannelManage;
    assert!(holds(&app.db, fx.space_id, fx.member, Resource::File(file), link).await);
    assert!(!holds(&app.db, fx.space_id, other, Resource::File(file), link).await);
    assert!(
        holds(
            &app.db,
            fx.space_id,
            fx.member,
            Resource::Channel(channel),
            manage
        )
        .await
    );
    assert!(
        !holds(
            &app.db,
            fx.space_id,
            other,
            Resource::Channel(channel),
            manage
        )
        .await
    );
    // The ceiling holds for the guest in the group.
    join_as(&app.db, channel, fx.guest, "member").await;
    assert!(
        !holds(
            &app.db,
            fx.space_id,
            fx.guest,
            Resource::Channel(channel),
            manage
        )
        .await
    );
    assert!(!holds(&app.db, fx.space_id, fx.guest, Resource::File(file), link).await);
    // A rule for a group shows in the explanation.
    let why = check::explain(&app.db, fx.space_id, fx.member, Resource::File(file))
        .await
        .expect("explain");
    assert!(why.trace.iter().any(|step| {
        step.permission == Permission::FilesPublicLink
            && step.source == crate::permissions::engine::Source::Group(group)
    }));
    // Leaving the group takes the rule away at once.
    exec(
        &app.db,
        "DELETE FROM space_group_members WHERE group_id = $1 AND user_id = $2",
        vec![group.into(), fx.member.into()],
    )
    .await
    .expect("leave");
    assert!(!holds(&app.db, fx.space_id, fx.member, Resource::File(file), link).await);
}

#[tokio::test]
async fn a_group_and_a_role_rule_union_their_denies_first() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let group = make_group(&app.db, fx.space_id, "Equipe").await;
    put_in_group(&app.db, group, fx.space_id, fx.member, false).await;
    let role = make_role(&app.db, fx.space_id, "Relecteur", 20, &["files.view"]).await;
    assign(&app.db, fx.space_id, fx.member, role).await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "a.txt").await;
    // The group denies editing, the role allows it: the denies of both go first.
    grant(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("group_id", group),
        &[],
        &["files.edit"],
    )
    .await;
    grant(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("role_id", role),
        &["files.edit"],
        &[],
    )
    .await;
    assert!(
        holds(
            &app.db,
            fx.space_id,
            fx.member,
            Resource::File(file),
            Permission::FilesEdit
        )
        .await
    );
    // Alone, the group's deny takes editing from the base.
    let other = make_file(&app.db, fx.space_id, fx.owner, "b.txt").await;
    grant(
        &app.db,
        fx.space_id,
        ("file_id", other),
        ("group_id", group),
        &[],
        &["files.edit"],
    )
    .await;
    assert!(
        !holds(
            &app.db,
            fx.space_id,
            fx.member,
            Resource::File(other),
            Permission::FilesEdit
        )
        .await
    );
}

#[tokio::test]
async fn an_audience_rule_needs_the_channel_view() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let other = add_member(&app.db, fx.space_id, "autre").await;
    let private = make_channel(&app.db, fx.space_id, "secret", "private").await;
    join_as(&app.db, private, fx.member, "member").await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "a.txt").await;
    grant(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("audience_channel_id", private),
        &["files.public_link"],
        &[],
    )
    .await;
    let link = Permission::FilesPublicLink;
    let asks = |who: Uuid| {
        let db = &app.db;
        let space = fx.space_id;
        async move { holds(db, space, who, Resource::File(file), link).await }
    };
    assert!(asks(fx.member).await, "a reader of the channel");
    assert!(
        !asks(other).await,
        "a member who cannot view the private channel"
    );
    // Many files at once agree with one.
    let many = check::files_effective(&app.db, fx.space_id, fx.member, &[file])
        .await
        .expect("many");
    assert!(many[&file].contains(link));
    let many = check::files_effective(&app.db, fx.space_id, other, &[file])
        .await
        .expect("many");
    assert!(!many[&file].contains(link));
    // Leaving the channel takes it away at once.
    exec(
        &app.db,
        "DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2",
        vec![private.into(), fx.member.into()],
    )
    .await
    .expect("leave");
    assert!(!asks(fx.member).await);
    // A public channel is read by every member.
    let public = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let shared = make_file(&app.db, fx.space_id, fx.owner, "b.txt").await;
    grant(
        &app.db,
        fx.space_id,
        ("file_id", shared),
        ("audience_channel_id", public),
        &["files.public_link"],
        &[],
    )
    .await;
    assert!(holds(&app.db, fx.space_id, other, Resource::File(shared), link).await);
    // A guest is never lifted above the ceiling by it.
    join_as(&app.db, public, fx.guest, "member").await;
    assert!(!holds(&app.db, fx.space_id, fx.guest, Resource::File(shared), link).await);
}

#[tokio::test]
async fn an_audience_rule_never_loads_file_rules_of_the_channel() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "a.txt").await;
    let mut audiences = Vec::new();
    for n in 0..3 {
        let channel = make_channel(&app.db, fx.space_id, &format!("lecteurs-{n}"), "public").await;
        // File rules of the audience's own conversation files must not be read for it.
        let attached = make_file(&app.db, fx.space_id, fx.owner, &format!("c{n}.txt")).await;
        exec(
            &app.db,
            "UPDATE files SET conversation_id = $1 WHERE id = $2",
            vec![channel.into(), attached.into()],
        )
        .await
        .expect("attach to the audience's conversation");
        grant(
            &app.db,
            fx.space_id,
            ("file_id", attached),
            ("user_id", fx.member),
            &["files.manage"],
            &[],
        )
        .await;
        audiences.push(channel);
    }
    let db = app.db.clone();
    let queries = || {
        let before = crate::permissions::load::queries_issued(fx.space_id);
        let db = db.clone();
        let space = fx.space_id;
        let user = fx.member;
        async move {
            check::files_effective(&db, space, user, &[file])
                .await
                .expect("effective");
            crate::permissions::load::queries_issued(space) - before
        }
    };
    let none = queries().await;
    grant(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("audience_channel_id", audiences[0]),
        &["files.view"],
        &[],
    )
    .await;
    let one = queries().await;
    for channel in &audiences[1..] {
        grant(
            &app.db,
            fx.space_id,
            ("file_id", file),
            ("audience_channel_id", *channel),
            &["files.view"],
            &[],
        )
        .await;
    }
    let three = queries().await;
    assert_eq!(one, none + 3, "channels, their rules, the memberships");
    assert_eq!(three, one, "the count does not grow with the audiences");
}

/// A private channel, and one person outside it (not joined).
async fn locked_room(db: &DatabaseConnection, fx: &super::permissions_tests::Ladder) -> Uuid {
    make_channel(
        db,
        fx.space_id,
        &format!("prive-{}", Uuid::new_v4().simple()),
        "private",
    )
    .await
}

#[tokio::test]
async fn the_private_lock_is_lifted_only_by_a_group_person_or_custom_role() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let view = Permission::ChannelView;
    let space = fx.space_id;

    let closed = locked_room(&app.db, &fx).await;
    assert!(!holds(&app.db, space, fx.member, Resource::Channel(closed), view).await);

    // A group.
    let group = make_group(&app.db, space, "Equipe").await;
    put_in_group(&app.db, group, space, fx.member, false).await;
    let by_group = locked_room(&app.db, &fx).await;
    grant(
        &app.db,
        space,
        ("channel_id", by_group),
        ("group_id", group),
        &["channel.view"],
        &[],
    )
    .await;
    assert!(holds(&app.db, space, fx.member, Resource::Channel(by_group), view).await);

    // A person.
    let by_person = locked_room(&app.db, &fx).await;
    grant(
        &app.db,
        space,
        ("channel_id", by_person),
        ("user_id", fx.member),
        &["channel.view"],
        &[],
    )
    .await;
    assert!(
        holds(
            &app.db,
            space,
            fx.member,
            Resource::Channel(by_person),
            view
        )
        .await
    );

    // A custom role.
    let role = make_role(&app.db, space, "Invite", 20, &["files.view"]).await;
    assign(&app.db, space, fx.member, role).await;
    let by_role = locked_room(&app.db, &fx).await;
    grant(
        &app.db,
        space,
        ("channel_id", by_role),
        ("role_id", role),
        &["channel.view"],
        &[],
    )
    .await;
    assert!(holds(&app.db, space, fx.member, Resource::Channel(by_role), view).await);

    // Not the Administrator role, not `@members`.
    let administrator = system_role(&app.db, space, "administrator").await;
    let members = system_role(&app.db, space, "members").await;
    let by_admin = locked_room(&app.db, &fx).await;
    grant(
        &app.db,
        space,
        ("channel_id", by_admin),
        ("role_id", administrator),
        &["channel.view"],
        &[],
    )
    .await;
    assert!(!holds(&app.db, space, fx.admin, Resource::Channel(by_admin), view).await);
    let by_members = locked_room(&app.db, &fx).await;
    grant(
        &app.db,
        space,
        ("channel_id", by_members),
        ("role_id", members),
        &["channel.view"],
        &[],
    )
    .await;
    assert!(
        !holds(
            &app.db,
            space,
            fx.member,
            Resource::Channel(by_members),
            view
        )
        .await
    );
    // The rooms the group, the person and the role did not name stay closed to them.
    assert!(!holds(&app.db, space, fx.member, Resource::Channel(closed), view).await);
    // An audience rule cannot sit on a channel at all (the schema forbids it).
    assert!(rule(
        &app.db,
        space,
        ("channel_id", closed),
        &[("audience_channel_id", by_group)]
    )
    .await
    .is_err());
}

#[tokio::test]
async fn a_deny_after_the_allow_keeps_the_lock() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let space = fx.space_id;
    let group = make_group(&app.db, space, "Equipe").await;
    put_in_group(&app.db, group, space, fx.member, false).await;
    let room = locked_room(&app.db, &fx).await;
    grant(
        &app.db,
        space,
        ("channel_id", room),
        ("group_id", group),
        &["channel.view"],
        &[],
    )
    .await;
    assert!(
        holds(
            &app.db,
            space,
            fx.member,
            Resource::Channel(room),
            Permission::ChannelView
        )
        .await
    );
    grant(
        &app.db,
        space,
        ("channel_id", room),
        ("user_id", fx.member),
        &[],
        &["channel.view"],
    )
    .await;
    assert!(
        !holds(
            &app.db,
            space,
            fx.member,
            Resource::Channel(room),
            Permission::ChannelView
        )
        .await
    );
}

#[tokio::test]
async fn a_reservation_never_lifts_the_private_lock() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let room = locked_room(&app.db, &fx).await;
    reserve(&app.db, room, &["admin"]).await;
    let view = Permission::ChannelView;
    assert!(
        !holds(
            &app.db,
            fx.space_id,
            fx.admin,
            Resource::Channel(room),
            view
        )
        .await
    );
    join_as(&app.db, room, fx.admin, "member").await;
    assert!(
        holds(
            &app.db,
            fx.space_id,
            fx.admin,
            Resource::Channel(room),
            view
        )
        .await
    );
}

#[tokio::test]
async fn an_allow_lists_the_channel_and_join_works() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let space = fx.space_id;
    let group = make_group(&app.db, space, "Equipe").await;
    put_in_group(&app.db, group, space, fx.member, false).await;
    let room = locked_room(&app.db, &fx).await;
    let cookie = app.cookie_for(fx.member).await;
    let listed = |cookie: String| {
        let app = &app;
        async move {
            let response = app
                .req(
                    reqwest::Method::GET,
                    &format!("/api/v1/spaces/{space}/channels"),
                    &cookie,
                )
                .send()
                .await
                .expect("list");
            assert_eq!(response.status(), 200);
            let body: Value = response.json().await.expect("json");
            body.as_array()
                .map(|channels| channels.iter().any(|c| c["id"] == room.to_string()))
                .unwrap_or(false)
        }
    };
    assert!(!listed(cookie.clone()).await);
    let refused = app
        .req(
            reqwest::Method::PUT,
            &format!("/api/v1/channels/{room}/membership"),
            &cookie,
        )
        .send()
        .await
        .expect("join");
    assert_eq!(refused.status(), 403);

    grant(
        &app.db,
        space,
        ("channel_id", room),
        ("group_id", group),
        &["channel.view"],
        &[],
    )
    .await;
    assert!(listed(cookie.clone()).await, "the sidebar lists it");
    let joined = app
        .req(
            reqwest::Method::PUT,
            &format!("/api/v1/channels/{room}/membership"),
            &cookie,
        )
        .send()
        .await
        .expect("join");
    assert_eq!(joined.status(), 204);
    assert_eq!(
        count(
            &app.db,
            "SELECT count(*) AS n FROM channel_members WHERE channel_id = $1 AND user_id = $2",
            vec![room.into(), fx.member.into()]
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &app.db,
            "SELECT count(*) AS n FROM notifications WHERE conversation_id = $1",
            vec![room.into()]
        )
        .await,
        0,
        "joining notifies nobody"
    );
}

#[tokio::test]
async fn a_guest_stays_under_the_ceiling_through_every_target() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let space = fx.space_id;
    let group = make_group(&app.db, space, "Equipe").await;
    put_in_group(&app.db, group, space, fx.guest, false).await;
    let role = make_role(&app.db, space, "Tout", 20, &["files.view"]).await;
    assign(&app.db, space, fx.guest, role).await;
    let readers = make_channel(&app.db, space, "lecteurs", "public").await;
    join_as(&app.db, readers, fx.guest, "member").await;
    let channel = make_channel(&app.db, space, "salon", "public").await;
    join_as(&app.db, channel, fx.guest, "member").await;
    let file = make_file(&app.db, space, fx.owner, "a.txt").await;
    let every: Vec<&str> = Permission::ALL.iter().map(|p| p.name()).collect();

    for (column, id) in [
        ("group_id", group),
        ("user_id", fx.guest),
        ("role_id", role),
    ] {
        grant(
            &app.db,
            space,
            ("channel_id", channel),
            (column, id),
            &every,
            &[],
        )
        .await;
        grant(&app.db, space, ("file_id", file), (column, id), &every, &[]).await;
    }
    grant(
        &app.db,
        space,
        ("file_id", file),
        ("audience_channel_id", readers),
        &every,
        &[],
    )
    .await;

    let ceiling = crate::permissions::system_roles::GUEST_CEILING;
    let on_channel = check::effective(&app.db, space, fx.guest, Resource::Channel(channel))
        .await
        .expect("channel");
    let on_file = check::effective(&app.db, space, fx.guest, Resource::File(file))
        .await
        .expect("file");
    assert_eq!(on_channel.intersect(ceiling), Default::default());
    assert_eq!(on_file.intersect(ceiling), Default::default());
    assert!(on_channel.contains(Permission::MessageSend));
}

#[tokio::test]
async fn a_later_non_lifting_allow_does_not_reopen_a_lock_a_deny_closed() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let space = fx.space_id;
    let group = make_group(&app.db, space, "Equipe").await;
    put_in_group(&app.db, group, space, fx.member, false).await;
    let room = locked_room(&app.db, &fx).await;
    // A file of the room: its channel's rules come first, then the file's.
    let file = make_file(&app.db, space, fx.owner, "a.txt").await;
    exec(
        &app.db,
        "UPDATE files SET conversation_id = $1 WHERE id = $2",
        vec![room.into(), file.into()],
    )
    .await
    .expect("attach");
    let members = system_role(&app.db, space, "members").await;
    grant(
        &app.db,
        space,
        ("channel_id", room),
        ("group_id", group),
        &["channel.view"],
        &[],
    )
    .await;
    grant(
        &app.db,
        space,
        ("channel_id", room),
        ("user_id", fx.member),
        &[],
        &["channel.view"],
    )
    .await;
    grant(
        &app.db,
        space,
        ("file_id", file),
        ("role_id", members),
        &["channel.view"],
        &[],
    )
    .await;
    // The deny took the view, the file's `@members` allow gives it back without lifting the lock:
    // the room, never joined, stays closed, so its file stays unread.
    assert!(
        !holds(
            &app.db,
            space,
            fx.member,
            Resource::File(file),
            Permission::FilesView
        )
        .await
    );
    // Control: without the deny the group's opening stands.
    exec(
        &app.db,
        "DELETE FROM permission_overrides WHERE channel_id = $1 AND user_id = $2",
        vec![room.into(), fx.member.into()],
    )
    .await
    .expect("lift the deny");
    assert!(
        holds(
            &app.db,
            space,
            fx.member,
            Resource::File(file),
            Permission::FilesView
        )
        .await
    );
}

#[tokio::test]
async fn a_guest_never_joined_is_opened_by_a_person_or_group_rule_only() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let space = fx.space_id;
    let view = Permission::ChannelView;
    let group = make_group(&app.db, space, "Invites").await;
    put_in_group(&app.db, group, space, fx.guest, false).await;
    let guests = system_role(&app.db, space, "guests").await;
    let administrator = system_role(&app.db, space, "administrator").await;
    let every: Vec<&str> = Permission::ALL.iter().map(|p| p.name()).collect();

    let by_person = locked_room(&app.db, &fx).await;
    grant(
        &app.db,
        space,
        ("channel_id", by_person),
        ("user_id", fx.guest),
        &every,
        &[],
    )
    .await;
    let by_group = locked_room(&app.db, &fx).await;
    grant(
        &app.db,
        space,
        ("channel_id", by_group),
        ("group_id", group),
        &every,
        &[],
    )
    .await;
    for room in [by_person, by_group] {
        let held = check::effective(&app.db, space, fx.guest, Resource::Channel(room))
            .await
            .expect("effective");
        assert!(held.contains(view));
        assert_eq!(
            held.intersect(crate::permissions::system_roles::GUEST_CEILING),
            Default::default(),
            "the ceiling still holds in a room opened by a rule"
        );
    }
    for role in [guests, administrator] {
        let room = locked_room(&app.db, &fx).await;
        grant(
            &app.db,
            space,
            ("channel_id", room),
            ("role_id", role),
            &["channel.view"],
            &[],
        )
        .await;
        assert!(!holds(&app.db, space, fx.guest, Resource::Channel(room), view).await);
    }
}
