//! Let a notification be a broadcast.
//!
//! `@canal` and `@ici` reach someone as one of the room rather than by name, which is a weaker
//! claim on their attention and the one people most often want to turn off. Telling the two apart
//! needs a kind of its own, and the column that holds it is constrained to the three that existed
//! when it was created, so the value has to be allowed before it can be written.
//!
//! Nothing is backfilled. Broadcasts sent before this migration were recorded as plain mentions and
//! there is no way to tell now which of them were: guessing from the message body would be a guess,
//! and a notification already read is not worth one.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check \
             CHECK (kind IN ('mention', 'broadcast', 'reply', 'dm'));",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // The rows have to go before the constraint can: a value the constraint forbids cannot be
        // left behind, and a broadcast has no older kind it could honestly be turned into.
        db.execute_unprepared("DELETE FROM notifications WHERE kind = 'broadcast';")
            .await?;
        db.execute_unprepared(
            "ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check \
             CHECK (kind IN ('mention', 'reply', 'dm'));",
        )
        .await?;
        Ok(())
    }
}
