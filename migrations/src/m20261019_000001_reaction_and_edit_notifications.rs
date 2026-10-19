//! Two notification kinds about a message of one's own or one already heard about: `reaction`
//! (someone reacted to my message; the emoji in `payload`) and `edited` (a message I was told about
//! has changed). Both are about a message, so the subject constraint already covers them; the kind
//! constraint learns them here.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = "\
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check; \
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ( \
    'mention', 'broadcast', 'reply', 'dm', 'message', 'reaction', 'edited', 'calendar_reminder', \
    'calendar_invitation', 'calendar_update', 'calendar_cancel', 'calendar_declined', \
    'calendar_shared'));";

const DOWN: &str = "\
DELETE FROM notifications WHERE kind IN ('reaction', 'edited'); \
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check; \
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ( \
    'mention', 'broadcast', 'reply', 'dm', 'message', 'calendar_reminder', \
    'calendar_invitation', 'calendar_update', 'calendar_cancel', 'calendar_declined', \
    'calendar_shared'));";

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
