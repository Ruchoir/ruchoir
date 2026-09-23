//! Give each person who imports their own set of correspondences.
//!
//! An import recognises what an earlier one wrote through `import_mappings`, keyed by the source's
//! own identifiers. That was safe while only administrators of the instance could import. Now that
//! anyone may, two people bringing over archives from the same product would share one namespace:
//! the second would resolve to the first one's spaces and accounts and write into them, or be
//! refused by the unique index when it tried to record its own.
//!
//! `owner_id` is null for an administrator's import (the instance's own namespace, unchanged) and
//! names the importer otherwise. The identity index for instance-level rows (accounts and spaces)
//! gains the column, with `NULLS NOT DISTINCT` so the administrators' namespace stays unique too.
//! Space-scoped rows need nothing: a scoped import only ever writes into spaces it created.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE import_mappings ADD COLUMN IF NOT EXISTS owner_id uuid;",
        )
        .await?;
        db.execute_unprepared("DROP INDEX IF EXISTS import_mappings_instance_identity_idx;")
            .await?;
        db.execute_unprepared(
            "CREATE UNIQUE INDEX import_mappings_instance_identity_idx \
             ON import_mappings (source, kind, external_ref, owner_id) NULLS NOT DISTINCT \
             WHERE space_id IS NULL;",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // Only the administrators' namespace can be kept under the old index.
        db.execute_unprepared("DELETE FROM import_mappings WHERE owner_id IS NOT NULL;")
            .await?;
        db.execute_unprepared("DROP INDEX IF EXISTS import_mappings_instance_identity_idx;")
            .await?;
        db.execute_unprepared(
            "CREATE UNIQUE INDEX import_mappings_instance_identity_idx \
             ON import_mappings (source, kind, external_ref) \
             WHERE space_id IS NULL;",
        )
        .await?;
        db.execute_unprepared("ALTER TABLE import_mappings DROP COLUMN IF EXISTS owner_id;")
            .await?;
        Ok(())
    }
}
