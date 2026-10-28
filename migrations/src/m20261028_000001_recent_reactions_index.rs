//! The quick reactions lead with the emoji someone used last (`GET /api/v1/me/recent-reactions`):
//! an index on a person's reactions by date keeps that a short walk rather than a scan.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE INDEX IF NOT EXISTS idx_message_reactions_user_recent ON message_reactions (user_id, created_at DESC);",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP INDEX IF EXISTS idx_message_reactions_user_recent;")
            .await?;
        Ok(())
    }
}
