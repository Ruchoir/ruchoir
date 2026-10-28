//! A thread reply may be sent to its channel too (Slack's "also send to channel"): it stays in its
//! thread and shows in the channel's feed as well, where it counts as the channel's own messages do.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS also_in_channel BOOLEAN NOT NULL DEFAULT false;",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("ALTER TABLE messages DROP COLUMN IF EXISTS also_in_channel;")
            .await?;
        Ok(())
    }
}
