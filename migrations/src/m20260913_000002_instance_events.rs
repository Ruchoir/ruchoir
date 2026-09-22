//! Things that happened to the instance itself, rather than inside it.
//!
//! Two entries so far, and they have the same shape for the same reason: both have to survive the
//! thing they describe.
//!
//! A **backup** writes a row when it finishes, because the API cannot see the files a shell script
//! produced and has no other way to know one exists. That matters for exactly one decision: the
//! import can wipe an instance before refilling it, and it refuses to do so without a recent
//! backup. A guard that trusted a checkbox would be decoration.
//!
//! A **replacement** writes a row when it runs, and that row is the only account of it left: the
//! spaces, the accounts and the messages it destroyed are gone, so if the record lived among them
//! there would be nothing to read afterwards. Nothing here is ever deleted by the product.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            CREATE TABLE instance_events (
                id uuid NOT NULL PRIMARY KEY,
                kind text NOT NULL CHECK (kind IN ('backup_taken', 'instance_replaced')),
                occurred_at timestamptz NOT NULL DEFAULT now(),
                -- Who did it, when anyone did. A backup taken by a timer has nobody behind it, and
                -- the account that ordered a replacement may itself be gone by the time this is
                -- read, so the reference is deliberately loose.
                actor_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
                -- What was done, in words, for a person reading this months later: which archive,
                -- how large, how many spaces and accounts were destroyed.
                detail text NOT NULL DEFAULT '{}'
            );
            "#,
        )
        .await?;

        db.execute_unprepared(
            "CREATE INDEX instance_events_kind_time_idx \
             ON instance_events (kind, occurred_at DESC);",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS instance_events;")
            .await?;
        Ok(())
    }
}
