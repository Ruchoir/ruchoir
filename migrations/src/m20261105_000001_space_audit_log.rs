//! A space's audit log (permissions lot 2, design section 6): who changed which rights, when.
//!
//! Append-only by construction: a trigger refuses every UPDATE but the one the database itself makes
//! when an account is deleted (`actor_id` set to NULL, the row otherwise unchanged: the entry stays,
//! anonymous), and every DELETE but the cascade of a deleted space. `at` is the clock at the write
//! (`clock_timestamp()`), so the entries of one transaction keep their order.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = r#"
CREATE TABLE IF NOT EXISTS space_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    space_id uuid NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
    at timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
    action text NOT NULL,
    target_kind text NOT NULL
        CHECK (target_kind IN ('member', 'role', 'channel', 'calendar', 'space', 'licence')),
    target_id uuid,
    details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS space_audit_log_space_at ON space_audit_log (space_id, at DESC, id DESC);

CREATE OR REPLACE FUNCTION space_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.actor_id IS NOT NULL AND NEW.actor_id IS NULL
           AND NEW.id = OLD.id AND NEW.space_id = OLD.space_id AND NEW.at = OLD.at
           AND NEW.action = OLD.action AND NEW.target_kind = OLD.target_kind
           AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id AND NEW.details = OLD.details THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'the audit log is append-only';
    END IF;
    IF EXISTS (SELECT 1 FROM spaces WHERE id = OLD.space_id) THEN
        RAISE EXCEPTION 'the audit log is append-only';
    END IF;
    RETURN OLD;
END $$;

CREATE OR REPLACE TRIGGER space_audit_log_append_only BEFORE UPDATE OR DELETE ON space_audit_log
    FOR EACH ROW EXECUTE FUNCTION space_audit_log_append_only();
"#;

const DOWN: &str = r#"
DROP TRIGGER IF EXISTS space_audit_log_append_only ON space_audit_log;
DROP FUNCTION IF EXISTS space_audit_log_append_only();
DROP TABLE IF EXISTS space_audit_log;
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
