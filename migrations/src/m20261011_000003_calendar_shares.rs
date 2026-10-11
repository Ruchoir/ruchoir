//! Sharing a personal calendar with someone: at one of three levels, `freebusy` (busy blocks
//! only), `read` (the details, as an invitee reads them) or `write` (its events too). A share goes
//! with the calendar or either account; whether the two people still have a space in common is
//! checked when it is read, so leaving a space needs no clean-up.
//!
//! A share opened notifies its person (`calendar_shared`, in the app only), which the notification
//! constraints learn here.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = "\
CREATE TABLE calendar_shares ( \
    calendar_id uuid NOT NULL REFERENCES calendars (id) ON DELETE CASCADE, \
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, \
    level text NOT NULL CHECK (level IN ('freebusy', 'read', 'write')), \
    created_by uuid REFERENCES users (id) ON DELETE SET NULL, \
    created_at timestamptz NOT NULL DEFAULT now(), \
    PRIMARY KEY (calendar_id, user_id) \
); \
CREATE INDEX calendar_shares_user ON calendar_shares (user_id); \
\
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check; \
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ( \
    'mention', 'broadcast', 'reply', 'dm', 'message', 'calendar_reminder', \
    'calendar_invitation', 'calendar_update', 'calendar_cancel', 'calendar_declined', \
    'calendar_shared')); \
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_subject_check; \
ALTER TABLE notifications ADD CONSTRAINT notifications_subject_check CHECK ( \
    (kind = 'calendar_reminder' AND event_id IS NOT NULL AND occurrence_start IS NOT NULL \
         AND conversation_id IS NULL AND message_id IS NULL) \
    OR (kind IN ('calendar_invitation', 'calendar_update', 'calendar_declined') \
         AND event_id IS NOT NULL AND payload IS NOT NULL \
         AND conversation_id IS NULL AND message_id IS NULL) \
    OR (kind IN ('calendar_cancel', 'calendar_shared') AND payload IS NOT NULL \
         AND conversation_id IS NULL AND message_id IS NULL) \
    OR (kind NOT LIKE 'calendar\\_%' AND conversation_id IS NOT NULL AND message_id IS NOT NULL));";

const DOWN: &str = "\
DELETE FROM notifications WHERE kind = 'calendar_shared'; \
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_subject_check; \
ALTER TABLE notifications ADD CONSTRAINT notifications_subject_check CHECK ( \
    (kind = 'calendar_reminder' AND event_id IS NOT NULL AND occurrence_start IS NOT NULL \
         AND conversation_id IS NULL AND message_id IS NULL) \
    OR (kind IN ('calendar_invitation', 'calendar_update', 'calendar_declined') \
         AND event_id IS NOT NULL AND payload IS NOT NULL \
         AND conversation_id IS NULL AND message_id IS NULL) \
    OR (kind = 'calendar_cancel' AND payload IS NOT NULL \
         AND conversation_id IS NULL AND message_id IS NULL) \
    OR (kind NOT LIKE 'calendar\\_%' AND conversation_id IS NOT NULL AND message_id IS NOT NULL)); \
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check; \
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ( \
    'mention', 'broadcast', 'reply', 'dm', 'message', 'calendar_reminder', \
    'calendar_invitation', 'calendar_update', 'calendar_cancel', 'calendar_declined')); \
DROP TABLE IF EXISTS calendar_shares;";

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
