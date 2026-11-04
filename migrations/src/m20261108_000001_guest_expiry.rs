//! Guests' end dates (permissions lot 5, design sections 1 and 2).
//!
//! - `space_members.expiry_stage` remembers how far the reminders went (`7`, `1`, then `0` for
//!   "access ended, announced"); `NULL` before any. Only a guest carries one, and the standing
//!   trigger clears it with the date when someone stops being a guest.
//! - `space_invitations.guest_expires_at` is the absolute end an invitation hands to the guest it
//!   admits (guest invitations only); it has nothing to do with the link's own lifetime.
//! - `notifications` learns two kinds, `guest_expiry_soon` (to those who manage the guest) and
//!   `guest_access_ending` (to the guest). Both carry a `payload` and no conversation.
//! - A partial index serves the sweep that looks for guests whose end is near or past.
//!
//! The audit log needs nothing: its `action` column is free text. DOWN never touches its rows.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = r#"
ALTER TABLE space_members ADD COLUMN expiry_stage smallint;
ALTER TABLE space_members
    ADD CONSTRAINT space_members_expiry_stage_check
        CHECK (expiry_stage IS NULL OR expiry_stage IN (0, 1, 7)),
    ADD CONSTRAINT space_members_expiry_stage_guest_check
        CHECK (expiry_stage IS NULL OR standing = 'guest');
CREATE INDEX space_members_expires_at ON space_members (expires_at)
    WHERE expires_at IS NOT NULL;

ALTER TABLE space_invitations ADD COLUMN guest_expires_at timestamptz;
ALTER TABLE space_invitations
    ADD CONSTRAINT space_invitations_guest_expires_check
        CHECK (guest_expires_at IS NULL OR role = 'guest');

CREATE OR REPLACE FUNCTION permissions_member_standing() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.standing := CASE NEW.role WHEN 'owner' THEN 'owner' WHEN 'guest' THEN 'guest' ELSE 'member' END;
    IF NEW.standing <> 'guest' THEN
        NEW.expires_at := NULL;
        NEW.expiry_notice_sent_at := NULL;
        NEW.expiry_stage := NULL;
    END IF;
    RETURN NEW;
END $$;

DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'notifications'::regclass AND contype = 'c'
                AND conname IN ('notifications_kind_check', 'notifications_subject_check') LOOP
        EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'mention', 'broadcast', 'reply', 'dm', 'message', 'reaction', 'edited', 'calendar_reminder',
    'calendar_invitation', 'calendar_update', 'calendar_cancel', 'calendar_declined',
    'calendar_shared', 'guest_expiry_soon', 'guest_access_ending'));
ALTER TABLE notifications ADD CONSTRAINT notifications_subject_check CHECK (
    (kind = 'calendar_reminder' AND event_id IS NOT NULL AND occurrence_start IS NOT NULL
         AND conversation_id IS NULL AND message_id IS NULL)
    OR (kind IN ('calendar_invitation', 'calendar_update', 'calendar_declined')
         AND event_id IS NOT NULL AND payload IS NOT NULL
         AND conversation_id IS NULL AND message_id IS NULL)
    OR (kind IN ('calendar_cancel', 'calendar_shared') AND payload IS NOT NULL
         AND conversation_id IS NULL AND message_id IS NULL)
    OR (kind IN ('guest_expiry_soon', 'guest_access_ending') AND payload IS NOT NULL
         AND event_id IS NULL AND conversation_id IS NULL AND message_id IS NULL)
    OR (kind NOT LIKE 'calendar\_%' AND kind NOT LIKE 'guest\_%'
         AND conversation_id IS NOT NULL AND message_id IS NOT NULL));
"#;

// The audit log is append-only and untouched. The notices of the two new kinds go first, then the
// previous checks come back.
const DOWN: &str = r#"
DELETE FROM notifications WHERE kind IN ('guest_expiry_soon', 'guest_access_ending');
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_subject_check;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'mention', 'broadcast', 'reply', 'dm', 'message', 'reaction', 'edited', 'calendar_reminder',
    'calendar_invitation', 'calendar_update', 'calendar_cancel', 'calendar_declined',
    'calendar_shared'));
ALTER TABLE notifications ADD CONSTRAINT notifications_subject_check CHECK (
    (kind = 'calendar_reminder' AND event_id IS NOT NULL AND occurrence_start IS NOT NULL
         AND conversation_id IS NULL AND message_id IS NULL)
    OR (kind IN ('calendar_invitation', 'calendar_update', 'calendar_declined')
         AND event_id IS NOT NULL AND payload IS NOT NULL
         AND conversation_id IS NULL AND message_id IS NULL)
    OR (kind IN ('calendar_cancel', 'calendar_shared') AND payload IS NOT NULL
         AND conversation_id IS NULL AND message_id IS NULL)
    OR (kind NOT LIKE 'calendar\_%' AND conversation_id IS NOT NULL AND message_id IS NOT NULL));

CREATE OR REPLACE FUNCTION permissions_member_standing() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.standing := CASE NEW.role WHEN 'owner' THEN 'owner' WHEN 'guest' THEN 'guest' ELSE 'member' END;
    IF NEW.standing <> 'guest' THEN
        NEW.expires_at := NULL;
        NEW.expiry_notice_sent_at := NULL;
    END IF;
    RETURN NEW;
END $$;

ALTER TABLE space_invitations DROP CONSTRAINT IF EXISTS space_invitations_guest_expires_check;
ALTER TABLE space_invitations DROP COLUMN IF EXISTS guest_expires_at;
DROP INDEX IF EXISTS space_members_expires_at;
ALTER TABLE space_members DROP CONSTRAINT IF EXISTS space_members_expiry_stage_guest_check;
ALTER TABLE space_members DROP CONSTRAINT IF EXISTS space_members_expiry_stage_check;
ALTER TABLE space_members DROP COLUMN IF EXISTS expiry_stage;
"#;

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
