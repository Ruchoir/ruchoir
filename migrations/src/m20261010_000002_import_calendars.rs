//! An import brings calendars and their events over: it maps them as it maps conversations and
//! messages, and counts them so the screen can say how far it has gone.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = "\
ALTER TABLE import_jobs \
    ADD COLUMN calendars_total integer NOT NULL DEFAULT 0, \
    ADD COLUMN calendars_done integer NOT NULL DEFAULT 0, \
    ADD COLUMN events_total integer NOT NULL DEFAULT 0, \
    ADD COLUMN events_done integer NOT NULL DEFAULT 0; \
ALTER TABLE import_mappings DROP CONSTRAINT import_mappings_kind_check; \
ALTER TABLE import_mappings ADD CONSTRAINT import_mappings_kind_check \
    CHECK (kind IN ('space', 'user', 'channel', 'message', 'file', 'calendar', 'event'));";

const DOWN: &str = "\
DELETE FROM import_mappings WHERE kind IN ('calendar', 'event'); \
ALTER TABLE import_mappings DROP CONSTRAINT import_mappings_kind_check; \
ALTER TABLE import_mappings ADD CONSTRAINT import_mappings_kind_check \
    CHECK (kind IN ('space', 'user', 'channel', 'message', 'file')); \
ALTER TABLE import_jobs \
    DROP COLUMN IF EXISTS events_done, \
    DROP COLUMN IF EXISTS events_total, \
    DROP COLUMN IF EXISTS calendars_done, \
    DROP COLUMN IF EXISTS calendars_total;";

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
