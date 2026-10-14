//! Let an invitation bring someone into one group of a space rather than the space at large.
//!
//! Whoever runs a channel may invite a person from outside into it, as a guest who sees that channel
//! only. `channel_id` names it; on acceptance the invitee joins it instead of the space's default
//! channel. Null keeps the invitation what it always was: into the space. Deleting the channel takes
//! the invitations into it along.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE space_invitations ADD COLUMN IF NOT EXISTS channel_id uuid \
             REFERENCES channels (id) ON DELETE CASCADE;",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("ALTER TABLE space_invitations DROP COLUMN IF EXISTS channel_id;")
            .await?;
        Ok(())
    }
}
