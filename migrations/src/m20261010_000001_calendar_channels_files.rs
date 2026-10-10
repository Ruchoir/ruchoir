//! The calendar meets the rest of Ruchoir: an event may be linked to a channel (where it is
//! discussed, announced with a card, and listed as upcoming) and carry files from the Drive.
//!
//! A card is a system message pointing at its event (`messages.event_id`), so it is drawn as the
//! event stands; it outlives the event, which only clears the pointer. Files stay where they are in
//! the Drive: the link table only says which events carry them, and an event gives whoever sees it
//! read access to its files.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = "\
ALTER TABLE calendar_events ADD COLUMN channel_id uuid REFERENCES channels (id) ON DELETE SET NULL; \
CREATE INDEX calendar_events_channel ON calendar_events (channel_id) WHERE channel_id IS NOT NULL; \
\
CREATE TABLE calendar_event_files ( \
    event_id uuid NOT NULL REFERENCES calendar_events (id) ON DELETE CASCADE, \
    file_id uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE, \
    added_by uuid REFERENCES users (id) ON DELETE SET NULL, \
    added_at timestamptz NOT NULL DEFAULT now(), \
    PRIMARY KEY (event_id, file_id) \
); \
CREATE INDEX calendar_event_files_file ON calendar_event_files (file_id); \
\
ALTER TABLE messages ADD COLUMN event_id uuid REFERENCES calendar_events (id) ON DELETE SET NULL; \
CREATE INDEX messages_event ON messages (event_id) WHERE event_id IS NOT NULL;";

const DOWN: &str = "\
ALTER TABLE messages DROP COLUMN IF EXISTS event_id; \
DROP TABLE IF EXISTS calendar_event_files; \
ALTER TABLE calendar_events DROP COLUMN IF EXISTS channel_id;";

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
