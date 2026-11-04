//! Migration up/down round-trip against a real PostgreSQL database.
//!
//! This test is **destructive** (it drops and re-applies every table), so it never runs against the
//! ordinary dev database. It is skipped unless `RUCHOIR_TEST_DATABASE_URL` points at a throwaway
//! database dedicated to tests. In CI (no PostgreSQL service) the variable is unset and the test is
//! a no-op, keeping `cargo test` green. To run it locally:
//!
//! ```sh
//! docker compose up -d db
//! createdb -h localhost -U ruchoir ruchoir_test   # or any empty database
//! RUCHOIR_TEST_DATABASE_URL=postgres://ruchoir:ruchoir@localhost:5432/ruchoir_test \
//!   cargo test -p ruchoir-api --test migrations_round_trip -- --nocapture
//! ```

use ruchoir_migration::{Migrator, MigratorTrait};
use sea_orm::Database;

/// Both tests rebuild the same throwaway database: they take turns.
static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn migrations_apply_and_revert_cleanly() {
    let _turn = ONE_AT_A_TIME.lock().await;
    let Ok(url) = std::env::var("RUCHOIR_TEST_DATABASE_URL") else {
        eprintln!("skipping migrations_round_trip: RUCHOIR_TEST_DATABASE_URL not set");
        return;
    };

    let db = Database::connect(url)
        .await
        .expect("connect to the test database");

    // Start from a clean, fully-applied schema regardless of prior state.
    Migrator::fresh(&db).await.expect("fresh apply");

    // Full teardown then full re-apply: proves every `down` and every `up` is correct and that the
    // dependency ordering (foreign keys, shared primary keys) holds in both directions.
    Migrator::down(&db, None)
        .await
        .expect("revert all migrations");
    Migrator::up(&db, None)
        .await
        .expect("re-apply all migrations");

    // A second cycle confirms the round-trip is repeatable, not just correct once.
    Migrator::down(&db, None)
        .await
        .expect("revert all migrations again");
    Migrator::up(&db, None)
        .await
        .expect("re-apply all migrations again");
}

/// The calendar migration gives every space that already exists its default calendar, named in the
/// language of the space's owner.
#[tokio::test]
async fn existing_spaces_receive_a_default_calendar() {
    use sea_orm::{ConnectionTrait, DbBackend, Statement};
    let _turn = ONE_AT_A_TIME.lock().await;

    let Ok(url) = std::env::var("RUCHOIR_TEST_DATABASE_URL") else {
        eprintln!("skipping existing_spaces_receive_a_default_calendar: RUCHOIR_TEST_DATABASE_URL not set");
        return;
    };
    let db = Database::connect(url)
        .await
        .expect("connect to the test database");
    Migrator::fresh(&db).await.expect("fresh apply");
    // Step back to just before the calendar arrived, and fill the instance as it was then.
    let applied = Migrator::get_applied_migrations(&db)
        .await
        .expect("applied");
    let calendar_steps = applied
        .iter()
        .rev()
        .take_while(|m| m.name() != "m20261003_000003_file_stars")
        .count();
    Migrator::down(&db, Some(calendar_steps as u32))
        .await
        .expect("revert the calendar");

    let people = [
        (
            "00000000-0000-0000-0000-0000000000a1",
            "fr",
            "00000000-0000-0000-0000-0000000000b1",
        ),
        (
            "00000000-0000-0000-0000-0000000000a2",
            "de",
            "00000000-0000-0000-0000-0000000000b2",
        ),
        // No language chosen: English.
        (
            "00000000-0000-0000-0000-0000000000a3",
            "",
            "00000000-0000-0000-0000-0000000000b3",
        ),
    ];
    for (age, (user, locale, space)) in people.into_iter().enumerate() {
        // The oldest space first, for the colours to be handed out in a known order.
        let minutes = 10 - age;
        let sql_locale = if locale.is_empty() {
            "NULL".to_owned()
        } else {
            format!("'{locale}'")
        };
        let slug = if locale.is_empty() { "none" } else { locale };
        db.execute_unprepared(&format!(
            "INSERT INTO users (id, email, display_name, status, mfa_enforced, is_instance_admin, \
                                is_bot, locale, created_at, updated_at) \
             VALUES ('{user}', '{user}@example.test', 'Owner', 'active', false, false, false, \
                     {sql_locale}, now(), now()); \
             INSERT INTO spaces (id, name, slug, created_at, updated_at) \
             VALUES ('{space}', 'Atelier {slug}', 'space-{slug}', \
                     now() - interval '{minutes} minutes', now()); \
             INSERT INTO space_members (space_id, user_id, role, joined_at) \
             VALUES ('{space}', '{user}', 'owner', now());"
        ))
        .await
        .expect("seed a space");
    }

    Migrator::up(&db, None).await.expect("apply the calendar");
    let rows = db
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT s.slug, c.name, c.color, c.write_access, c.default_reminders \
             FROM calendars c JOIN spaces s ON s.id = c.space_id \
             WHERE c.is_default ORDER BY s.slug;",
        ))
        .await
        .expect("read calendars");
    let found: Vec<(String, String, String, String, Vec<i32>)> = rows
        .iter()
        .map(|r| {
            (
                r.try_get("", "slug").unwrap(),
                r.try_get("", "name").unwrap(),
                r.try_get("", "color").unwrap(),
                r.try_get("", "write_access").unwrap(),
                r.try_get("", "default_reminders").unwrap(),
            )
        })
        .collect();
    let expected = |slug: &str, name: &str, color: &str| {
        (
            slug.to_owned(),
            name.to_owned(),
            color.to_owned(),
            "members".to_owned(),
            vec![10],
        )
    };
    assert_eq!(
        found,
        vec![
            // Named after their space, whatever their owner's language, in turn through the palette.
            expected("space-de", "Atelier de", "violet"),
            expected("space-fr", "Atelier fr", "mint"),
            expected("space-none", "Atelier none", "peach"),
        ]
    );
}

/// The guests' end-date migration steps back and forward with data in place: the columns, checks
/// and indexes come and go, the two notice kinds are cleared on the way down (nothing else is), and
/// the standing trigger forgets and learns `expiry_stage`.
#[tokio::test]
async fn the_migration_round_trips() {
    use sea_orm::ConnectionTrait;
    let _turn = ONE_AT_A_TIME.lock().await;
    let Ok(url) = std::env::var("RUCHOIR_TEST_DATABASE_URL") else {
        eprintln!("skipping the_migration_round_trips: RUCHOIR_TEST_DATABASE_URL not set");
        return;
    };
    let db = Database::connect(url)
        .await
        .expect("connect to the test database");
    Migrator::fresh(&db).await.expect("fresh apply");

    let count = |sql: &'static str| {
        let db = &db;
        async move {
            db.query_one_raw(sea_orm::Statement::from_string(
                sea_orm::DbBackend::Postgres,
                sql,
            ))
            .await
            .expect("query")
            .expect("row")
            .try_get::<i64>("", "n")
            .expect("n")
        }
    };
    let columns = "SELECT count(*) AS n FROM information_schema.columns \
                   WHERE (table_name = 'space_members' AND column_name = 'expiry_stage') \
                      OR (table_name = 'space_invitations' AND column_name = 'guest_expires_at')";
    let checks = "SELECT count(*) AS n FROM pg_constraint WHERE conname IN \
                  ('space_members_expiry_stage_check', 'space_members_expiry_stage_guest_check', \
                   'space_invitations_guest_expires_check')";
    let index = "SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'space_members_expires_at'";
    let wide_kind = "SELECT count(*) AS n FROM pg_constraint \
                     WHERE conname = 'notifications_kind_check' \
                       AND pg_get_constraintdef(oid) LIKE '%guest_expiry_soon%'";
    assert_eq!(count(columns).await, 2);
    assert_eq!(count(checks).await, 3);
    assert_eq!(count(index).await, 1);
    assert_eq!(count(wide_kind).await, 1);

    db.execute_unprepared(
        "INSERT INTO users (id, email, display_name, status, mfa_enforced, is_instance_admin, \
                            is_bot, created_at, updated_at) \
         VALUES ('00000000-0000-0000-0000-0000000000c1', 'c1@example.test', 'C', 'active', false, \
                 false, false, now(), now()); \
         INSERT INTO notifications (id, user_id, kind, payload) \
         VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000c1', 'guest_access_ending', \
                 '{}'::jsonb);",
    )
    .await
    .expect("seed a guest notice");

    // A guest in a space, to watch the standing trigger from both sides of the migration.
    db.execute_unprepared(
        "INSERT INTO users (id, email, display_name, status, mfa_enforced, is_instance_admin, \
                            is_bot, created_at, updated_at) \
         VALUES ('00000000-0000-0000-0000-0000000000c2', 'c2@example.test', 'G', 'active', false, \
                 false, false, now(), now()); \
         INSERT INTO spaces (id, name, slug, created_at, updated_at) \
         VALUES ('00000000-0000-0000-0000-0000000000d1', 'Trigger', 'trigger', now(), now()); \
         INSERT INTO space_members (space_id, user_id, role, joined_at) \
         VALUES ('00000000-0000-0000-0000-0000000000d1', \
                 '00000000-0000-0000-0000-0000000000c2', 'guest', now());",
    )
    .await
    .expect("seed a guest");
    let make_guest_again = "UPDATE space_members SET role = 'guest' \
        WHERE user_id = '00000000-0000-0000-0000-0000000000c2'";
    let make_member = "UPDATE space_members SET role = 'member' \
        WHERE user_id = '00000000-0000-0000-0000-0000000000c2'";
    let stage_left = "SELECT count(*) AS n FROM space_members \
        WHERE user_id = '00000000-0000-0000-0000-0000000000c2' AND expiry_stage IS NOT NULL";

    // Back to just before this migration, whatever is added after it.
    let steps = Migrator::get_applied_migrations(&db)
        .await
        .expect("applied")
        .iter()
        .rev()
        .take_while(|m| m.name() != "m20261108_000001_guest_expiry")
        .count()
        + 1;
    Migrator::down(&db, Some(steps as u32)).await.expect("down");
    assert_eq!(count(columns).await, 0);
    assert_eq!(count(checks).await, 0);
    assert_eq!(count(index).await, 0);
    assert_eq!(count(wide_kind).await, 0);
    assert_eq!(
        count("SELECT count(*) AS n FROM notifications WHERE kind LIKE 'guest\\_%'").await,
        0,
        "the guest notices go with their kinds"
    );
    // The old trigger no longer touches the column that is gone: a role change still works.
    db.execute_unprepared(make_member)
        .await
        .expect("the restored trigger does not name expiry_stage");
    db.execute_unprepared(make_guest_again)
        .await
        .expect("guest");

    Migrator::up(&db, None).await.expect("up again");
    assert_eq!(count(columns).await, 2);
    assert_eq!(count(checks).await, 3);
    assert_eq!(count(index).await, 1);
    assert_eq!(count(wide_kind).await, 1);
    // The new trigger learns the column again: leaving guesthood clears the stage.
    db.execute_unprepared(
        "UPDATE space_members SET expiry_stage = 7 \
         WHERE user_id = '00000000-0000-0000-0000-0000000000c2'",
    )
    .await
    .expect("set a stage");
    assert_eq!(count(stage_left).await, 1);
    db.execute_unprepared(make_member).await.expect("promote");
    assert_eq!(count(stage_left).await, 0, "the trigger clears the stage");
}

/// The author columns of an access rule come and go with the migration (existing rows get NULLs,
/// the columns being nullable with no default).
#[tokio::test]
async fn the_rule_author_migration_round_trips() {
    use sea_orm::ConnectionTrait;
    let _turn = ONE_AT_A_TIME.lock().await;
    let Ok(url) = std::env::var("RUCHOIR_TEST_DATABASE_URL") else {
        eprintln!("skipping the_rule_author_migration_round_trips: no test database");
        return;
    };
    let db = Database::connect(url)
        .await
        .expect("connect to the test database");
    Migrator::fresh(&db).await.expect("fresh apply");

    let count = |sql: &'static str| {
        let db = &db;
        async move {
            db.query_one_raw(sea_orm::Statement::from_string(
                sea_orm::DbBackend::Postgres,
                sql,
            ))
            .await
            .expect("query")
            .expect("row")
            .try_get::<i64>("", "n")
            .expect("n")
        }
    };
    let columns = "SELECT count(*) AS n FROM information_schema.columns \
                   WHERE table_name = 'permission_overrides' \
                     AND column_name IN ('set_by', 'set_at')";
    assert_eq!(count(columns).await, 2);

    // Back to just before this migration, whatever is added after it.
    let steps = Migrator::get_applied_migrations(&db)
        .await
        .expect("applied")
        .iter()
        .rev()
        .take_while(|m| m.name() != "m20261109_000001_rule_set_by")
        .count()
        + 1;
    Migrator::down(&db, Some(steps as u32)).await.expect("down");
    assert_eq!(count(columns).await, 0);

    Migrator::up(&db, None).await.expect("up again");
    assert_eq!(count(columns).await, 2);
    assert_eq!(
        count(
            "SELECT count(*) AS n FROM permission_overrides \
             WHERE set_by IS NOT NULL OR set_at IS NOT NULL"
        )
        .await,
        0
    );
}

/// Lot 6: the columns an import of people needs come with the migration and leave with it.
#[tokio::test]
async fn the_import_people_migration_round_trips() {
    use sea_orm::{ConnectionTrait, DbBackend, Statement};
    let _turn = ONE_AT_A_TIME.lock().await;
    let Ok(url) = std::env::var("RUCHOIR_TEST_DATABASE_URL") else {
        eprintln!(
            "skipping the_import_people_migration_round_trips: RUCHOIR_TEST_DATABASE_URL not set"
        );
        return;
    };
    let db = Database::connect(url)
        .await
        .expect("connect to the test database");
    Migrator::fresh(&db).await.expect("fresh apply");

    let columns = "SELECT count(*) AS n FROM information_schema.columns \
         WHERE (table_name = 'space_members' AND column_name = 'imported_from') \
            OR (table_name = 'space_groups' AND column_name = 'imported_from') \
            OR (table_name = 'import_jobs' AND column_name IN ('summary', 'attempt'))";
    let count = |sql: &'static str| {
        let db = &db;
        async move {
            let row = db
                .query_one_raw(Statement::from_string(DbBackend::Postgres, sql))
                .await
                .expect("query")
                .expect("row");
            row.try_get::<i64>("", "n").expect("n")
        }
    };
    assert_eq!(count(columns).await, 4);

    let steps = Migrator::get_applied_migrations(&db)
        .await
        .expect("applied")
        .iter()
        .rev()
        .take_while(|m| m.name() != "m20261110_000001_import_people")
        .count()
        + 1;
    Migrator::down(&db, Some(steps as u32)).await.expect("down");
    assert_eq!(count(columns).await, 0, "the four columns are gone");

    Migrator::up(&db, None).await.expect("up again");
    assert_eq!(count(columns).await, 4);
}
