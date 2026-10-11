//! Several reminders per event: a person's choice for an event, their choice for a calendar and a
//! calendar's default each become a list of delays (five at most). An empty list is "no reminder";
//! no row at all is still "as the calendar".
//!
//! What was sent is kept per delay, so the second reminder of a date is not taken for the first.
//! A row from before has no delay: it stands for every reminder of its date, so the reminders
//! already sent when this runs are not sent again under their new keys.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = "\
ALTER TABLE calendar_event_reminders ALTER COLUMN minutes TYPE integer[] \
    USING (CASE WHEN minutes IS NULL THEN '{}'::integer[] ELSE ARRAY[minutes] END); \
ALTER TABLE calendar_event_reminders ALTER COLUMN minutes SET NOT NULL; \
ALTER TABLE calendar_reminder_prefs ALTER COLUMN minutes TYPE integer[] \
    USING (CASE WHEN minutes IS NULL THEN '{}'::integer[] ELSE ARRAY[minutes] END); \
ALTER TABLE calendar_reminder_prefs ALTER COLUMN minutes SET NOT NULL; \
ALTER TABLE calendars ADD COLUMN default_reminders integer[] NOT NULL DEFAULT '{}'; \
UPDATE calendars SET default_reminders = ARRAY[default_reminder_minutes] \
    WHERE default_reminder_minutes IS NOT NULL; \
ALTER TABLE calendars DROP COLUMN default_reminder_minutes; \
ALTER TABLE calendar_reminder_deliveries ADD COLUMN minutes integer; \
ALTER TABLE calendar_reminder_deliveries DROP CONSTRAINT calendar_reminder_deliveries_pkey; \
CREATE UNIQUE INDEX calendar_reminder_deliveries_key ON calendar_reminder_deliveries \
    (user_id, event_id, occurrence_start, minutes) NULLS NOT DISTINCT;";

const DOWN: &str = "\
DROP INDEX IF EXISTS calendar_reminder_deliveries_key; \
DELETE FROM calendar_reminder_deliveries d USING calendar_reminder_deliveries e \
    WHERE d.user_id = e.user_id AND d.event_id = e.event_id \
    AND d.occurrence_start = e.occurrence_start AND d.ctid > e.ctid; \
ALTER TABLE calendar_reminder_deliveries DROP COLUMN minutes; \
ALTER TABLE calendar_reminder_deliveries ADD PRIMARY KEY (user_id, event_id, occurrence_start); \
ALTER TABLE calendars ADD COLUMN default_reminder_minutes integer; \
UPDATE calendars SET default_reminder_minutes = default_reminders[1]; \
ALTER TABLE calendars DROP COLUMN default_reminders; \
ALTER TABLE calendar_reminder_prefs ALTER COLUMN minutes DROP NOT NULL; \
ALTER TABLE calendar_reminder_prefs ALTER COLUMN minutes TYPE integer USING (minutes[1]); \
ALTER TABLE calendar_event_reminders ALTER COLUMN minutes DROP NOT NULL; \
ALTER TABLE calendar_event_reminders ALTER COLUMN minutes TYPE integer USING (minutes[1]);";

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
