//! Room for licences that check in (ADR 0010, amendment): what an edition built on this crate keeps
//! between two check-ins. The community build never writes these.
//!
//! - `space_licences` gains the next document waiting to take over, the latest status the edition
//!   accepted (opaque text, verified every time it is read) with its time, and the times of the
//!   last successful check-in and of the last attempt.
//! - `licence_instance` is one row: the random id the instance draws once, and the highest time it
//!   has seen (a clock that goes back further than a day is refused).
//! - `licence_kill_notices` keeps every notice received, forever.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = "\
ALTER TABLE space_licences \
    ADD COLUMN IF NOT EXISTS next_licence text NULL, \
    ADD COLUMN IF NOT EXISTS status_token text NULL, \
    ADD COLUMN IF NOT EXISTS status_token_issued_at timestamptz NULL, \
    ADD COLUMN IF NOT EXISTS last_check_in_at timestamptz NULL, \
    ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz NULL; \
CREATE TABLE IF NOT EXISTS licence_instance ( \
    id smallint PRIMARY KEY CHECK (id = 1), \
    instance_id uuid NOT NULL, \
    highest_seen timestamptz NOT NULL \
); \
CREATE TABLE IF NOT EXISTS licence_kill_notices ( \
    serial uuid PRIMARY KEY, \
    notice text NOT NULL, \
    received_at timestamptz NOT NULL DEFAULT now() \
);";

const DOWN: &str = "\
DROP TABLE IF EXISTS licence_kill_notices; \
DROP TABLE IF EXISTS licence_instance; \
ALTER TABLE space_licences \
    DROP COLUMN IF EXISTS next_licence, \
    DROP COLUMN IF EXISTS status_token, \
    DROP COLUMN IF EXISTS status_token_issued_at, \
    DROP COLUMN IF EXISTS last_check_in_at, \
    DROP COLUMN IF EXISTS last_attempt_at;";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(UP).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(DOWN).await?;
        Ok(())
    }
}
