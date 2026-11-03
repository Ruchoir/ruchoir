//! The audit log against a real database: written by `audit::record` alone, never updated or
//! deleted by anything but the database's own cascades. Same harness as the parent module.

use super::*;

use crate::audit::{record, Action, Target};

async fn entries(db: &DatabaseConnection, space_id: Uuid) -> Vec<(String, Option<Uuid>)> {
    db.query_all_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT action, actor_id FROM space_audit_log WHERE space_id = $1 ORDER BY at",
        [space_id.into()],
    ))
    .await
    .expect("entries")
    .into_iter()
    .map(|row| {
        (
            row.try_get::<String>("", "action").expect("action"),
            row.try_get::<Option<Uuid>>("", "actor_id").expect("actor"),
        )
    })
    .collect()
}

#[tokio::test]
async fn the_audit_log_refuses_updates_and_deletes() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    record(
        &app.db,
        space,
        Some(owner),
        Action::MemberJoined,
        Target::Member(owner),
        json!({ "role": "owner" }),
    )
    .await
    .expect("record");
    for statement in [
        "UPDATE space_audit_log SET action = 'role.deleted' WHERE space_id = $1",
        "UPDATE space_audit_log SET details = '{}' WHERE space_id = $1",
        "DELETE FROM space_audit_log WHERE space_id = $1",
    ] {
        let refused = app
            .db
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                statement,
                [space.into()],
            ))
            .await;
        assert!(refused.is_err(), "{statement} was allowed");
    }
    assert_eq!(
        entries(&app.db, space).await,
        vec![("member.joined".to_owned(), Some(owner))]
    );
}

#[tokio::test]
async fn a_deleted_account_leaves_anonymous_rows() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let actor = make_user(&app.db, "leaving").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    record(
        &app.db,
        space,
        Some(actor),
        Action::MemberRemoved,
        Target::Member(owner),
        json!({}),
    )
    .await
    .expect("record");
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM users WHERE id = $1",
            [actor.into()],
        ))
        .await
        .expect("account deleted");
    assert_eq!(
        entries(&app.db, space).await,
        vec![("member.removed".to_owned(), None)]
    );
}

#[tokio::test]
async fn a_deleted_space_takes_its_log() {
    let Some(app) = boot().await else { return };
    let owner = make_user(&app.db, "owner").await;
    let space = crate::testkit::make_space(&app.db, owner, "Audit").await;
    record(
        &app.db,
        space,
        Some(owner),
        Action::RoleCreated,
        Target::Role(Uuid::new_v4()),
        json!({ "name": "Comptable" }),
    )
    .await
    .expect("record");
    app.db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM spaces WHERE id = $1",
            [space.into()],
        ))
        .await
        .expect("space deleted");
    assert!(entries(&app.db, space).await.is_empty());
}

#[test]
fn no_code_writes_to_the_audit_log_but_record() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut stack = vec![src.clone()];
    let mut offenders = Vec::new();
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let relative = path
                .strip_prefix(&src)
                .expect("inside src")
                .to_string_lossy()
                .to_string();
            // The writer itself, its entity, and the tests (this one included) may name the table.
            if relative.starts_with("audit/")
                || relative == "entities/space_audit_log.rs"
                || relative.starts_with("tests_integration")
            {
                if relative.starts_with("audit/") {
                    let text = std::fs::read_to_string(&path).expect("read");
                    let upper = text.to_uppercase();
                    if upper.contains("UPDATE SPACE_AUDIT_LOG")
                        || upper.contains("DELETE FROM SPACE_AUDIT_LOG")
                    {
                        offenders.push(format!("{relative}: changes rows"));
                    }
                }
                continue;
            }
            if path.extension().is_some_and(|e| e == "rs") {
                let text = std::fs::read_to_string(&path).expect("read");
                if text.contains("space_audit_log") {
                    offenders.push(relative);
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "the audit log is written by audit::record alone: {offenders:?}"
    );
}
