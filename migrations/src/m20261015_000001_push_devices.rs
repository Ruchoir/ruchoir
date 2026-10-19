//! Phone notifications (ADR 0006): one row per phone that allowed them.
//!
//! `token` is the device token Apple (APNs) or Google (FCM) handed the app, unique: the same phone
//! registering again, or another account signing in on it, updates the row rather than adding a
//! second one, so nobody is woken twice or on someone else's behalf. `last_seen_at` is refreshed at
//! every start of the app; a phone unseen for sixty days is forgotten. Rows go with the account.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "CREATE TABLE IF NOT EXISTS push_devices ( \
                 id uuid PRIMARY KEY, \
                 user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, \
                 platform text NOT NULL CHECK (platform IN ('ios', 'android')), \
                 token text NOT NULL UNIQUE, \
                 created_at timestamptz NOT NULL DEFAULT now(), \
                 last_seen_at timestamptz NOT NULL DEFAULT now() \
             );",
        )
        .await?;
        db.execute_unprepared(
            "CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices (user_id);",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE IF EXISTS push_devices;")
            .await?;
        Ok(())
    }
}
