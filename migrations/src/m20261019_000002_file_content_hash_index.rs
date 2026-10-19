//! Uploads look for the same bytes already in the space (no duplicates, whenever the first copy
//! came): an index on the versions' digest keeps that a lookup rather than a scan.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE INDEX IF NOT EXISTS idx_file_versions_content_hash ON file_versions (content_hash);",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP INDEX IF EXISTS idx_file_versions_content_hash;")
            .await?;
        Ok(())
    }
}
