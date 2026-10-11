//! Two lookups the calendar makes often and had no index for: the notifications of an event (a
//! cancellation, a change, a reminder read back) and the subscriptions of a calendar (revoked when
//! it is deleted).

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = "\
CREATE INDEX IF NOT EXISTS notifications_event ON notifications (event_id) WHERE event_id IS NOT NULL; \
CREATE INDEX IF NOT EXISTS calendar_feed_tokens_calendar ON calendar_feed_tokens (calendar_id) \
    WHERE calendar_id IS NOT NULL;";

const DOWN: &str = "\
DROP INDEX IF EXISTS calendar_feed_tokens_calendar; \
DROP INDEX IF EXISTS notifications_event;";

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
