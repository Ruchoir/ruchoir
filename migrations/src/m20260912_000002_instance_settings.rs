//! Instance-wide settings: one row, holding what an administrator decides for the whole server.
//!
//! Distinct from space settings (which belong to a space) and from user preferences (which belong to
//! a person). The single row is enforced by a primary key that can only ever hold one value, so the
//! table cannot silently grow a second, contradictory set of settings.
//!
//! First setting: whether the interface shows who administers the instance. It is on by default,
//! because account recovery without a mail relay ends with "ask an administrator" and that only
//! works if they can be identified; an instance that would rather not designate anyone publicly
//! turns it off.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE TABLE instance_settings ( \
                     id boolean PRIMARY KEY DEFAULT true CHECK (id), \
                     show_instance_admins boolean NOT NULL DEFAULT true, \
                     updated_at timestamptz NOT NULL DEFAULT now() \
                 );",
            )
            .await?;

        // Seed the single row, so every reader can assume it exists rather than each one deciding
        // what a missing row means.
        manager
            .get_connection()
            .execute_unprepared("INSERT INTO instance_settings (id) VALUES (true);")
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS instance_settings;")
            .await?;
        Ok(())
    }
}
