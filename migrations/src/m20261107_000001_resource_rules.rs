//! Resource rules aimed at a group or at the readers of a channel (permissions lot 4).
//!
//! - `permission_overrides.group_id` makes a group a rule's target, beside a role or a person. The
//!   foreign key is `ON DELETE RESTRICT`: a rule that denies something never goes silently with the
//!   group it names (the routes remove the rules first, in the same transaction).
//! - `permission_overrides.audience_channel_id` makes "whoever reads this channel" a target, on
//!   files and folders only (the CHECK keeps it off channels and calendars). The rule goes with the
//!   channel it names.
//! - Exactly one target per rule, and at most one rule per resource and target, as for the others.
//!
//! The audit log learns the target kind `file`. DOWN never touches it (it is append-only) and
//! leaves its check accepting `file`; it removes the rules the previous version cannot hold.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = r#"
ALTER TABLE permission_overrides
    ADD COLUMN group_id uuid,
    ADD COLUMN audience_channel_id uuid;
ALTER TABLE permission_overrides
    ADD FOREIGN KEY (group_id, space_id) REFERENCES space_groups (id, space_id) ON DELETE RESTRICT,
    ADD FOREIGN KEY (audience_channel_id, space_id) REFERENCES channels (id, space_id) ON DELETE CASCADE;

ALTER TABLE permission_overrides DROP CONSTRAINT permission_overrides_one_target;
ALTER TABLE permission_overrides ADD CONSTRAINT permission_overrides_one_target
    CHECK (num_nonnulls(role_id, user_id, group_id, audience_channel_id) = 1);
ALTER TABLE permission_overrides ADD CONSTRAINT permission_overrides_audience_files_only
    CHECK (audience_channel_id IS NULL OR file_id IS NOT NULL);

CREATE UNIQUE INDEX permission_overrides_channel_group ON permission_overrides (channel_id, group_id)
    WHERE channel_id IS NOT NULL AND group_id IS NOT NULL;
CREATE UNIQUE INDEX permission_overrides_file_group ON permission_overrides (file_id, group_id)
    WHERE file_id IS NOT NULL AND group_id IS NOT NULL;
CREATE UNIQUE INDEX permission_overrides_calendar_group ON permission_overrides (calendar_id, group_id)
    WHERE calendar_id IS NOT NULL AND group_id IS NOT NULL;
CREATE UNIQUE INDEX permission_overrides_file_audience ON permission_overrides (file_id, audience_channel_id)
    WHERE file_id IS NOT NULL AND audience_channel_id IS NOT NULL;
CREATE INDEX permission_overrides_group ON permission_overrides (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX permission_overrides_audience ON permission_overrides (audience_channel_id)
    WHERE audience_channel_id IS NOT NULL;

DO $$
DECLARE
    v_name text;
BEGIN
    SELECT conname INTO v_name FROM pg_constraint
     WHERE conrelid = 'space_audit_log'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%target_kind%';
    IF v_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE space_audit_log DROP CONSTRAINT %I', v_name);
    END IF;
    ALTER TABLE space_audit_log ADD CONSTRAINT space_audit_log_target_kind_check
        CHECK (target_kind IN ('member', 'role', 'channel', 'calendar', 'space', 'licence', 'group', 'file'));
END $$;
"#;

// The audit log is append-only: DOWN leaves its `target_kind` check accepting `file`. The rules
// that name a group or an audience cannot exist in the previous shape, so they go.
const DOWN: &str = r#"
DELETE FROM permission_overrides WHERE group_id IS NOT NULL OR audience_channel_id IS NOT NULL;
DROP INDEX IF EXISTS permission_overrides_channel_group;
DROP INDEX IF EXISTS permission_overrides_file_group;
DROP INDEX IF EXISTS permission_overrides_calendar_group;
DROP INDEX IF EXISTS permission_overrides_file_audience;
DROP INDEX IF EXISTS permission_overrides_group;
DROP INDEX IF EXISTS permission_overrides_audience;
ALTER TABLE permission_overrides DROP CONSTRAINT IF EXISTS permission_overrides_audience_files_only;
ALTER TABLE permission_overrides DROP CONSTRAINT IF EXISTS permission_overrides_one_target;
ALTER TABLE permission_overrides DROP COLUMN group_id, DROP COLUMN audience_channel_id;
ALTER TABLE permission_overrides ADD CONSTRAINT permission_overrides_one_target
    CHECK (num_nonnulls(role_id, user_id) = 1);
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
