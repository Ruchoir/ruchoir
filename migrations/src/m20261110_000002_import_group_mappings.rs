//! An import of people also maps the groups and custom roles it makes (permissions lot 6): a
//! re-run finds a group by its archive id and keeps a renamed one's new name, and finds a role it
//! created instead of asking for it again.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = "\
ALTER TABLE import_mappings DROP CONSTRAINT import_mappings_kind_check; \
ALTER TABLE import_mappings ADD CONSTRAINT import_mappings_kind_check \
    CHECK (kind IN ('space', 'user', 'channel', 'message', 'file', 'calendar', 'event', \
                    'group', 'role'));";

const DOWN: &str = "\
DELETE FROM import_mappings WHERE kind IN ('group', 'role'); \
ALTER TABLE import_mappings DROP CONSTRAINT import_mappings_kind_check; \
ALTER TABLE import_mappings ADD CONSTRAINT import_mappings_kind_check \
    CHECK (kind IN ('space', 'user', 'channel', 'message', 'file', 'calendar', 'event'));";

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
