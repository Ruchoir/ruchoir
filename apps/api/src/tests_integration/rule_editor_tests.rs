//! Who edits a resource's access, against a real database: the kind of editor `editor_of` finds
//! for each rung of the ladder, what the "uses" of a group or a role lists, and the audit pieces.

use super::*;

use crate::audit::{record, Action, Target};
use crate::edition::{Edition, Entitlement, SeatCheck};
use crate::permissions::catalogue::Permission;
use crate::permissions::groups::Paid;
use crate::permissions::rules::{
    editor_of, hide_unopened, uses_of, EditorKind, Named, ResourceRef, UsedIn,
};

use super::delegation_tests::{assign, make_role};
use super::groups_tests::{make_group, put_in_group};
use super::permissions_tests::{join_as, ladder, space_calendar};

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

/// A rule aimed at a person, a group or a role.
async fn rule(
    db: &DatabaseConnection,
    space: Uuid,
    resource: (&str, Uuid),
    target: (&str, Uuid),
    allow: &[&str],
) {
    let allow: Vec<String> = allow.iter().map(|p| (*p).to_owned()).collect();
    exec(
        db,
        &format!(
            "INSERT INTO permission_overrides (space_id, {}, {}, allow) VALUES ($1, $2, $3, $4)",
            resource.0, target.0
        ),
        vec![
            space.into(),
            resource.1.into(),
            target.1.into(),
            allow.into(),
        ],
    )
    .await;
}

struct Licensed(bool);

#[async_trait::async_trait]
impl Edition for Licensed {
    fn name(&self) -> &'static str {
        "licensed"
    }

    async fn entitlement(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<Entitlement, sea_orm::DbErr> {
        Ok(if self.0 {
            Entitlement::Enterprise {
                seats: 7,
                valid_until: time::macros::datetime!(2027-12-31 0:00 UTC),
            }
        } else {
            Entitlement::Frozen {
                seats: 7,
                expired_at: time::macros::datetime!(2026-01-01 0:00 UTC),
            }
        })
    }

    async fn seat_check(
        &self,
        _db: &DatabaseConnection,
        _space_id: Uuid,
    ) -> Result<SeatCheck, sea_orm::DbErr> {
        Ok(SeatCheck::Full { seats: 7 })
    }

    fn routes(&self) -> axum::Router<AppState> {
        axum::Router::new()
    }

    fn features(&self) -> &'static [&'static str] {
        &[]
    }

    fn background(&self, _state: AppState) {}
}

async fn kind_of(
    app: &TestApp,
    space: Uuid,
    user: Uuid,
    resource: ResourceRef,
) -> Option<EditorKind> {
    editor_of(&app.state, space, user, resource)
        .await
        .expect("editor")
        .map(|editor| editor.kind)
}

#[tokio::test]
async fn editor_of_follows_ruling_4_on_every_family() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "plan.txt").await;
    let calendar = space_calendar(&app.db, fx.space_id, "members").await;
    let resources = [
        ResourceRef::Channel(channel),
        ResourceRef::File(file),
        ResourceRef::Calendar(calendar),
    ];
    for resource in resources {
        assert_eq!(
            kind_of(&app, fx.space_id, fx.owner, resource).await,
            Some(EditorKind::Owner)
        );
        assert_eq!(
            kind_of(&app, fx.space_id, fx.admin, resource).await,
            Some(EditorKind::Space)
        );
        assert_eq!(kind_of(&app, fx.space_id, fx.member, resource).await, None);
        assert_eq!(kind_of(&app, fx.space_id, fx.guest, resource).await, None);
        // Someone from nowhere is nobody.
        assert_eq!(
            kind_of(&app, fx.space_id, Uuid::new_v4(), resource).await,
            None
        );
    }
    // A custom role holding the manage permission at space level is a Space editor, for its family.
    let role = make_role(
        &app.db,
        fx.space_id,
        "Fichiers",
        20,
        &["files.manage", "files.view"],
    )
    .await;
    assign(&app.db, fx.space_id, fx.member, role).await;
    assert_eq!(
        kind_of(&app, fx.space_id, fx.member, ResourceRef::File(file)).await,
        Some(EditorKind::Space)
    );
    assert_eq!(
        kind_of(&app, fx.space_id, fx.member, ResourceRef::Channel(channel)).await,
        None
    );
}

#[tokio::test]
async fn editor_of_finds_a_channel_moderator_and_a_file_author() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    join_as(&app.db, channel, fx.member, "admin").await;
    let editor = editor_of(
        &app.state,
        fx.space_id,
        fx.member,
        ResourceRef::Channel(channel),
    )
    .await
    .expect("editor")
    .expect("moderator");
    assert_eq!(editor.kind, EditorKind::ChannelModerator);
    assert!(editor.rights.contains(Permission::ChannelManage));
    // The channel's moderator edits that channel only.
    let other = make_channel(&app.db, fx.space_id, "autre", "public").await;
    assert_eq!(
        kind_of(&app, fx.space_id, fx.member, ResourceRef::Channel(other)).await,
        None
    );
    // A guest's channel role is no rank.
    join_as(&app.db, channel, fx.guest, "admin").await;
    assert_eq!(
        kind_of(&app, fx.space_id, fx.guest, ResourceRef::Channel(channel)).await,
        None
    );

    // P3: the author of a file edits its sharing, in a free space too; not another file's.
    let mine = make_file(&app.db, fx.space_id, fx.member, "mine.txt").await;
    let theirs = make_file(&app.db, fx.space_id, fx.owner, "theirs.txt").await;
    let editor = editor_of(&app.state, fx.space_id, fx.member, ResourceRef::File(mine))
        .await
        .expect("editor")
        .expect("author");
    assert_eq!(editor.kind, EditorKind::Author);
    assert!(editor.rights.contains(Permission::FilesManage));
    assert_eq!(
        kind_of(&app, fx.space_id, fx.member, ResourceRef::File(theirs)).await,
        None
    );
}

#[tokio::test]
async fn a_local_manager_is_answered_with_the_licence_it_has() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let folder = make_file(&app.db, fx.space_id, fx.owner, "dossier").await;
    let calendar = space_calendar(&app.db, fx.space_id, "members").await;
    rule(
        &app.db,
        fx.space_id,
        ("file_id", folder),
        ("user_id", fx.member),
        &["files.view", "files.manage"],
    )
    .await;
    rule(
        &app.db,
        fx.space_id,
        ("calendar_id", calendar),
        ("user_id", fx.member),
        &["calendar.view", "calendar.manage"],
    )
    .await;
    for resource in [ResourceRef::File(folder), ResourceRef::Calendar(calendar)] {
        let editor = editor_of(&app.state, fx.space_id, fx.member, resource)
            .await
            .expect("editor")
            .expect("local");
        assert_eq!(editor.kind, EditorKind::Local);
        assert_eq!(
            editor.paid,
            Paid::Community,
            "the DTO says licence_required"
        );
        assert!(editor.rights.contains(resource.manage()));
    }
    // Holding something short of manage there is not editing the access.
    let other = make_file(&app.db, fx.space_id, fx.owner, "lecture").await;
    rule(
        &app.db,
        fx.space_id,
        ("file_id", other),
        ("user_id", fx.member),
        &["files.view", "files.edit"],
    )
    .await;
    assert_eq!(
        kind_of(&app, fx.space_id, fx.member, ResourceRef::File(other)).await,
        None
    );
}

#[tokio::test]
async fn a_licensed_space_answers_paid_enterprise() {
    let Some(server) = crate::testkit::boot_with(Arc::new(Licensed(true)), None, |_| {}).await
    else {
        return;
    };
    let db = &server.state.db;
    let fx = ladder(db).await;
    let folder = make_file(db, fx.space_id, fx.owner, "dossier").await;
    rule(
        db,
        fx.space_id,
        ("file_id", folder),
        ("user_id", fx.member),
        &["files.view", "files.manage"],
    )
    .await;
    let editor = editor_of(
        &server.state,
        fx.space_id,
        fx.member,
        ResourceRef::File(folder),
    )
    .await
    .expect("editor")
    .expect("local");
    assert_eq!(
        (editor.kind, editor.paid),
        (EditorKind::Local, Paid::Enterprise)
    );
}

#[tokio::test]
async fn editor_of_ignores_a_resource_of_another_space() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let elsewhere = ladder(&app.db).await;
    let channel = make_channel(&app.db, elsewhere.space_id, "ailleurs", "public").await;
    let file = make_file(&app.db, elsewhere.space_id, elsewhere.owner, "x.txt").await;
    for resource in [ResourceRef::Channel(channel), ResourceRef::File(file)] {
        assert_eq!(kind_of(&app, fx.space_id, fx.owner, resource).await, None);
        assert_eq!(kind_of(&app, fx.space_id, fx.admin, resource).await, None);
    }
}

#[tokio::test]
async fn uses_of_lists_where_a_group_or_a_role_is_named() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let unused = make_group(&app.db, fx.space_id, "Libre").await;
    put_in_group(&app.db, group, fx.space_id, fx.member, false).await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "Budget").await;
    let calendar = space_calendar(&app.db, fx.space_id, "members").await;
    let role = make_role(&app.db, fx.space_id, "Relecteur", 15, &["files.view"]).await;
    rule(
        &app.db,
        fx.space_id,
        ("channel_id", channel),
        ("group_id", group),
        &["channel.view"],
    )
    .await;
    rule(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("group_id", group),
        &["files.view"],
    )
    .await;
    rule(
        &app.db,
        fx.space_id,
        ("calendar_id", calendar),
        ("group_id", group),
        &["calendar.view"],
    )
    .await;
    rule(
        &app.db,
        fx.space_id,
        ("file_id", file),
        ("role_id", role),
        &["files.view"],
    )
    .await;

    let used = uses_of(&app.db, fx.space_id, Named::Group(group))
        .await
        .expect("uses");
    let want = |kind: &'static str, id: Uuid, name: &str| (kind, Some(id), Some(name.to_owned()));
    let plain = |used: &[UsedIn]| -> Vec<(&'static str, Option<Uuid>, Option<String>)> {
        used.iter()
            .map(|u| (u.kind, u.id, u.name.clone()))
            .collect()
    };
    assert_eq!(used.len(), 3, "{used:?}");
    for expected in [
        want("channel", channel, "salon"),
        want("file", file, "Budget"),
        want("calendar", calendar, "Planning"),
    ] {
        assert!(plain(&used).contains(&expected), "{expected:?} in {used:?}");
    }
    assert!(uses_of(&app.db, fx.space_id, Named::Group(unused))
        .await
        .expect("uses")
        .is_empty());
    assert_eq!(
        plain(
            &uses_of(&app.db, fx.space_id, Named::Role(role))
                .await
                .expect("uses")
        ),
        vec![want("file", file, "Budget")]
    );
    // Another space asking sees nothing of ours.
    let elsewhere = ladder(&app.db).await;
    assert!(uses_of(&app.db, elsewhere.space_id, Named::Group(group))
        .await
        .expect("uses")
        .is_empty());
}

#[tokio::test]
async fn rule_entries_are_readable_in_the_log_by_family_and_labelled_by_name() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "Budget").await;
    let channel = make_channel(&app.db, fx.space_id, "salon", "public").await;
    for (action, target) in [
        (Action::RuleCreated, Target::File(file)),
        (Action::RuleUpdated, Target::Channel(channel)),
        (Action::RuleDeleted, Target::File(file)),
    ] {
        record(
            &app.db,
            fx.space_id,
            Some(fx.admin),
            action,
            target,
            json!({ "target_kind": "group", "before": "read", "after": "contribute" }),
        )
        .await
        .expect("record");
    }
    // Rename the file after the fact: the log reads the current name.
    exec(
        &app.db,
        "UPDATE files SET name = 'Budget 2027' WHERE id = $1",
        vec![file.into()],
    )
    .await;
    let cookie = app.cookie_for(fx.owner).await;
    let response = app
        .req(
            reqwest::Method::GET,
            &format!("/api/v1/spaces/{}/audit?category=access", fx.space_id),
            &cookie,
        )
        .send()
        .await
        .expect("read log");
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("json");
    let entries = body["entries"].as_array().expect("entries");
    assert_eq!(entries.len(), 3);
    for entry in entries {
        assert_eq!(entry["category"], "access");
        assert!(entry["action"].as_str().unwrap().starts_with("rule."));
    }
    let on_file: Vec<&Value> = entries
        .iter()
        .filter(|e| e["target"]["kind"] == "file")
        .collect();
    assert_eq!(on_file.len(), 2);
    assert!(on_file
        .iter()
        .all(|e| e["target"]["label"] == "Budget 2027"));
    assert!(entries
        .iter()
        .any(|e| e["target"]["kind"] == "channel" && e["target"]["label"] == "salon"));
}

#[tokio::test]
async fn a_frozen_space_answers_paid_frozen() {
    let Some(server) = crate::testkit::boot_with(Arc::new(Licensed(false)), None, |_| {}).await
    else {
        return;
    };
    let db = &server.state.db;
    let fx = ladder(db).await;
    let folder = make_file(db, fx.space_id, fx.owner, "dossier").await;
    rule(
        db,
        fx.space_id,
        ("file_id", folder),
        ("user_id", fx.member),
        &["files.view", "files.manage"],
    )
    .await;
    let editor = editor_of(
        &server.state,
        fx.space_id,
        fx.member,
        ResourceRef::File(folder),
    )
    .await
    .expect("editor")
    .expect("local");
    assert_eq!(
        (editor.kind, editor.paid),
        (EditorKind::Local, Paid::Frozen)
    );
}

#[tokio::test]
async fn a_guest_author_and_a_former_member_edit_nothing() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let guest_file = make_file(&app.db, fx.space_id, fx.guest, "invite.txt").await;
    assert_eq!(
        kind_of(&app, fx.space_id, fx.guest, ResourceRef::File(guest_file)).await,
        None
    );
    // A member who wrote a file and then left (or was removed) edits nothing any more.
    let mine = make_file(&app.db, fx.space_id, fx.member, "mine.txt").await;
    assert_eq!(
        kind_of(&app, fx.space_id, fx.member, ResourceRef::File(mine)).await,
        Some(EditorKind::Author)
    );
    exec(
        &app.db,
        "DELETE FROM space_members WHERE space_id = $1 AND user_id = $2",
        vec![fx.space_id.into(), fx.member.into()],
    )
    .await;
    assert_eq!(
        kind_of(&app, fx.space_id, fx.member, ResourceRef::File(mine)).await,
        None
    );
}

#[tokio::test]
async fn a_space_editor_holds_the_family_at_space_level_whatever_the_resource_leaves() {
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let file = make_file(&app.db, fx.space_id, fx.owner, "secret.txt").await;
    exec(
        &app.db,
        "INSERT INTO permission_overrides (space_id, file_id, user_id, deny) VALUES ($1, $2, $3, $4)",
        vec![
            fx.space_id.into(),
            file.into(),
            fx.admin.into(),
            vec!["files.edit".to_owned()].into(),
        ],
    )
    .await;
    let editor = editor_of(&app.state, fx.space_id, fx.admin, ResourceRef::File(file))
        .await
        .expect("editor")
        .expect("space editor");
    assert_eq!(editor.kind, EditorKind::Space);
    // Rule 2 reads the family at space level: what the resource took away can still be granted.
    assert!(editor.rights.contains(Permission::FilesEdit));
    assert!(editor.rights.contains(Permission::FilesView));
    assert!(
        !editor.rights.contains(Permission::ChannelView),
        "the family only"
    );
}

#[tokio::test]
async fn a_place_naming_a_group_says_the_level_of_its_rule() {
    use crate::permissions::levels::{rule_sets, Kind, Level, Target};
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let parent = Uuid::new_v4();
    let folder = Uuid::new_v4();
    for (id, kind, parent_id) in [(parent, "folder", None), (folder, "folder", Some(parent))] {
        app.db
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "INSERT INTO files (id, space_id, owner_id, name, kind, parent_folder_id) \
                 VALUES ($1, $2, $3, $4, $5, $6)",
                [
                    id.into(),
                    fx.space_id.into(),
                    fx.owner.into(),
                    format!("dossier-{id}").into(),
                    kind.into(),
                    parent_id.into(),
                ],
            ))
            .await
            .expect("folder");
    }
    let (allow, deny) = rule_sets(Kind::File, Target::Group, Level::Read).expect("read");
    let allow = allow.to_names();
    let deny = deny.to_names();
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO permission_overrides (space_id, file_id, group_id, allow, deny) \
             VALUES ($1, $2, $3, $4, $5)",
            [
                fx.space_id.into(),
                folder.into(),
                group.into(),
                allow.into(),
                deny.into(),
            ],
        ))
        .await
        .expect("rule");
    let used = uses_of(&app.db, fx.space_id, Named::Group(group))
        .await
        .expect("uses");
    assert_eq!(used.len(), 1);
    assert_eq!(used[0].level, Some("read"));
    assert_eq!(used[0].parent_id, Some(parent));
    let json = serde_json::to_value(&used[0]).expect("json");
    assert_eq!(json["level"], "read");
    assert_eq!(json["parent_id"], parent.to_string());
    // A hidden place shows neither.
    let hidden = hide_unopened(&app.db, fx.space_id, fx.guest, used)
        .await
        .expect("hide");
    let json = serde_json::to_value(&hidden[0]).expect("json");
    assert_eq!(json["hidden"], true);
    assert!(json.get("level").is_none() && json.get("parent_id").is_none());
}

#[tokio::test]
async fn a_shown_place_names_no_folder_the_viewer_cannot_open() {
    use crate::permissions::levels::{rule_sets, Kind, Level, Target};
    let Some(app) = boot().await else { return };
    let fx = ladder(&app.db).await;
    let group = make_group(&app.db, fx.space_id, "Compta").await;
    let parent = Uuid::new_v4();
    let folder = Uuid::new_v4();
    for (id, parent_id) in [(parent, None), (folder, Some(parent))] {
        exec(
            &app.db,
            "INSERT INTO files (id, space_id, owner_id, name, kind, parent_folder_id) \
             VALUES ($1, $2, $3, $4, 'folder', $5)",
            vec![
                id.into(),
                fx.space_id.into(),
                fx.owner.into(),
                format!("dossier-{id}").into(),
                parent_id.into(),
            ],
        )
        .await;
    }
    // The member is kept out of the parent and let into the folder below it.
    exec(
        &app.db,
        "INSERT INTO permission_overrides (space_id, file_id, user_id, allow, deny) \
         VALUES ($1, $2, $3, '{}', $4)",
        vec![
            fx.space_id.into(),
            parent.into(),
            fx.member.into(),
            vec!["files.view".to_owned()].into(),
        ],
    )
    .await;
    rule(
        &app.db,
        fx.space_id,
        ("file_id", folder),
        ("user_id", fx.member),
        &["files.view"],
    )
    .await;
    let (allow, deny) = rule_sets(Kind::File, Target::Group, Level::Read).expect("read");
    exec(
        &app.db,
        "INSERT INTO permission_overrides (space_id, file_id, group_id, allow, deny) \
         VALUES ($1, $2, $3, $4, $5)",
        vec![
            fx.space_id.into(),
            folder.into(),
            group.into(),
            allow.to_names().into(),
            deny.to_names().into(),
        ],
    )
    .await;
    let used = uses_of(&app.db, fx.space_id, Named::Group(group))
        .await
        .expect("uses");
    let shown = hide_unopened(&app.db, fx.space_id, fx.member, used)
        .await
        .expect("hide");
    assert_eq!(shown.len(), 1);
    assert!(!shown[0].hidden, "the member opens the folder itself");
    assert_eq!(shown[0].id, Some(folder));
    assert_eq!(
        shown[0].parent_id, None,
        "the folder above is not theirs to learn"
    );
}
