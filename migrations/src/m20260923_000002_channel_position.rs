//! Let a space choose the order of its channels.
//!
//! Until now channels were listed in whatever order the database returned them, which is no order
//! at all. `position` is the space's own arrangement, set by its administrators and the same for
//! everybody in it. Null means "not placed yet": a channel created after the last arrangement goes
//! after the placed ones, in the order it was created.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("ALTER TABLE channels ADD COLUMN IF NOT EXISTS position integer;")
            .await?;
        // What every space's list is read by: its channels in the space's order.
        db.execute_unprepared(
            "CREATE INDEX IF NOT EXISTS channels_space_position_idx \
             ON channels (space_id, position NULLS LAST, created_at, id);",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP INDEX IF EXISTS channels_space_position_idx;")
            .await?;
        db.execute_unprepared("ALTER TABLE channels DROP COLUMN IF EXISTS position;")
            .await?;
        Ok(())
    }
}
