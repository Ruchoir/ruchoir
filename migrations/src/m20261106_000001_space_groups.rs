//! Groups (permissions lot 3, design section 3): named sets of members that carry roles.
//!
//! - `space_groups` belongs to a space; names are unique per space whatever the case. `source` and
//!   `external_id` are for groups a directory (Enterprise) keeps in step; `manual` ones are the
//!   space's own.
//! - `space_group_members` holds who is in which group, and whether they manage it. Both foreign keys
//!   are composite, so a person can only join a group of a space they are a member of, and leaving
//!   the space leaves its groups.
//! - `space_group_roles` holds the roles a group carries; the composite keys keep a group from
//!   carrying a role of another space.
//! - `space_role_holdings` is the one place that says who holds which role: directly (`group_id`
//!   NULL) or through a group (`group_id` set). The permission engine reads it instead of
//!   `space_role_assignments`.
//!
//! The audit log learns the target kind `group`, and mentions the type `group`.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const UP: &str = r#"
CREATE TABLE space_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    space_id uuid NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
    name citext NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    description text CHECK (char_length(description) <= 280),
    source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'directory')),
    external_id text,
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (space_id, name),
    UNIQUE (id, space_id)
);
CREATE UNIQUE INDEX space_groups_external_id_key ON space_groups (space_id, external_id)
    WHERE external_id IS NOT NULL;

CREATE TABLE space_group_members (
    group_id uuid NOT NULL,
    space_id uuid NOT NULL,
    user_id uuid NOT NULL,
    is_manager boolean NOT NULL DEFAULT false,
    added_by uuid REFERENCES users (id) ON DELETE SET NULL,
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (group_id, space_id) REFERENCES space_groups (id, space_id) ON DELETE CASCADE,
    FOREIGN KEY (space_id, user_id) REFERENCES space_members (space_id, user_id) ON DELETE CASCADE
);
CREATE INDEX space_group_members_member ON space_group_members (space_id, user_id);

CREATE TABLE space_group_roles (
    group_id uuid NOT NULL,
    space_id uuid NOT NULL,
    role_id uuid NOT NULL,
    PRIMARY KEY (group_id, role_id),
    FOREIGN KEY (group_id, space_id) REFERENCES space_groups (id, space_id) ON DELETE CASCADE,
    FOREIGN KEY (role_id, space_id) REFERENCES space_roles (id, space_id) ON DELETE CASCADE
);
CREATE INDEX space_group_roles_role ON space_group_roles (role_id);

CREATE VIEW space_role_holdings (space_id, user_id, role_id, group_id) AS
    SELECT space_id, user_id, role_id, NULL::uuid FROM space_role_assignments
    UNION ALL
    SELECT m.space_id, m.user_id, r.role_id, m.group_id
    FROM space_group_members m
    JOIN space_group_roles r ON r.group_id = m.group_id;

ALTER TABLE space_audit_log DROP CONSTRAINT IF EXISTS space_audit_log_target_kind_check;
ALTER TABLE space_audit_log ADD CONSTRAINT space_audit_log_target_kind_check
    CHECK (target_kind IN ('member', 'role', 'channel', 'calendar', 'space', 'licence', 'group'));
ALTER TABLE message_mentions DROP CONSTRAINT IF EXISTS message_mentions_mention_type_check;
ALTER TABLE message_mentions ADD CONSTRAINT message_mentions_mention_type_check
    CHECK (mention_type IN ('user', 'channel', 'here', 'group'));
"#;

// Rows already using `group` would refuse the narrower checks: remove them first (mentions of a
// group, and the audit entries about groups, exist only once this version has run).
const DOWN: &str = r#"
DELETE FROM message_mentions WHERE mention_type = 'group';
ALTER TABLE message_mentions DROP CONSTRAINT IF EXISTS message_mentions_mention_type_check;
ALTER TABLE message_mentions ADD CONSTRAINT message_mentions_mention_type_check
    CHECK (mention_type IN ('user', 'channel', 'here'));
ALTER TABLE space_audit_log DISABLE TRIGGER space_audit_log_append_only;
DELETE FROM space_audit_log WHERE target_kind = 'group';
ALTER TABLE space_audit_log ENABLE TRIGGER space_audit_log_append_only;
ALTER TABLE space_audit_log DROP CONSTRAINT IF EXISTS space_audit_log_target_kind_check;
ALTER TABLE space_audit_log ADD CONSTRAINT space_audit_log_target_kind_check
    CHECK (target_kind IN ('member', 'role', 'channel', 'calendar', 'space', 'licence'));
DROP VIEW IF EXISTS space_role_holdings;
DROP TABLE IF EXISTS space_group_roles;
DROP TABLE IF EXISTS space_group_members;
DROP TABLE IF EXISTS space_groups;
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
