//! Notification levels that inherit, a level per space, and a notification for every message.
//!
//! How much something notifies is now decided at three levels, the nearest one that says something
//! winning: the conversation, then its space, then the person's own default. So:
//!
//! - `channel_members.notification_level` and `dm_participants.notification_level` gain `default`
//!   ("do what the space says"), which becomes their default. Every existing `all` becomes `default`:
//!   `all` was the column's default and so said nothing about anybody's choice, and it now means
//!   something much louder (a notification for every message). The few set on purpose since the
//!   server started keeping them read "default" again.
//! - `space_notification_prefs` holds a level per person and space. No row is the default.
//! - `notifications.kind` gains `message`: a message that named nobody, sent to someone who asked to
//!   hear about every message there.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// Drop every CHECK constraint of `table` whose definition mentions `column`. The original ones were
/// created unnamed, so their names are Postgres's to choose; they are found by what they check.
fn drop_checks_on(table: &str, column: &str) -> String {
    format!(
        "DO $$ DECLARE r record; BEGIN \
           FOR r IN SELECT conname FROM pg_constraint \
                    WHERE conrelid = '{table}'::regclass AND contype = 'c' \
                      AND pg_get_constraintdef(oid) LIKE '%{column}%' LOOP \
             EXECUTE format('ALTER TABLE {table} DROP CONSTRAINT %I', r.conname); \
           END LOOP; \
         END $$;"
    )
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        for table in ["channel_members", "dm_participants"] {
            db.execute_unprepared(&drop_checks_on(table, "notification_level"))
                .await?;
            db.execute_unprepared(&format!(
                "UPDATE {table} SET notification_level = 'default' WHERE notification_level = 'all';"
            ))
            .await?;
            db.execute_unprepared(&format!(
                "ALTER TABLE {table} \
                     ALTER COLUMN notification_level SET DEFAULT 'default', \
                     ADD CONSTRAINT ck_{table}_notification_level \
                     CHECK (notification_level IN ('default', 'all', 'mentions', 'none'));"
            ))
            .await?;
        }

        db.execute_unprepared(
            "CREATE TABLE space_notification_prefs ( \
                 user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, \
                 space_id uuid NOT NULL REFERENCES spaces (id) ON DELETE CASCADE, \
                 level text NOT NULL CHECK (level IN ('all', 'mentions', 'none')), \
                 updated_at timestamptz NOT NULL DEFAULT now(), \
                 PRIMARY KEY (user_id, space_id) \
             );",
        )
        .await?;

        db.execute_unprepared(
            "ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check \
             CHECK (kind IN ('mention', 'broadcast', 'reply', 'dm', 'message'));",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DELETE FROM notifications WHERE kind = 'message';")
            .await?;
        db.execute_unprepared(
            "ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check \
             CHECK (kind IN ('mention', 'broadcast', 'reply', 'dm'));",
        )
        .await?;
        db.execute_unprepared("DROP TABLE IF EXISTS space_notification_prefs;")
            .await?;
        for table in ["channel_members", "dm_participants"] {
            db.execute_unprepared(&format!(
                "ALTER TABLE {table} DROP CONSTRAINT IF EXISTS ck_{table}_notification_level;"
            ))
            .await?;
            db.execute_unprepared(&format!(
                "UPDATE {table} SET notification_level = 'all' WHERE notification_level = 'default';"
            ))
            .await?;
            db.execute_unprepared(&format!(
                "ALTER TABLE {table} \
                     ALTER COLUMN notification_level SET DEFAULT 'all', \
                     ADD CONSTRAINT ck_{table}_notification_level_v1 \
                     CHECK (notification_level IN ('all', 'mentions', 'none'));"
            ))
            .await?;
        }
        Ok(())
    }
}
