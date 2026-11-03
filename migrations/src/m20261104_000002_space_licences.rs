//! A space's licence (ADR 0010): the signed document an owner installed, and what was read from it.
//!
//! The table is part of the core schema because the schema is not the product: the community build
//! never reads it beyond saying a space is `community`, and only an edition built elsewhere verifies
//! the document and acts on it. One row per space at most (a licence is bound to one space); the
//! row goes with the space. `reminded_days` is the last expiry reminder sent (30, 7 or 1 days
//! before `valid_until`), so none is sent twice; installing another licence starts it again.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE TABLE IF NOT EXISTS space_licences ( \
                     space_id uuid PRIMARY KEY REFERENCES spaces (id) ON DELETE CASCADE, \
                     licence text NOT NULL, \
                     licence_id uuid NOT NULL, \
                     organisation text NOT NULL, \
                     seats integer NOT NULL CHECK (seats > 0), \
                     valid_until timestamptz NOT NULL, \
                     installed_by uuid REFERENCES users (id) ON DELETE SET NULL, \
                     installed_at timestamptz NOT NULL DEFAULT now(), \
                     reminded_days integer CHECK (reminded_days IN (30, 7, 1)) \
                 );",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS space_licences;")
            .await?;
        Ok(())
    }
}
