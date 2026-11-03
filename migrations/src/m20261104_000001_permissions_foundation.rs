//! The permission foundation (permissions lot 1): standings, roles, role assignments and rules.
//!
//! - `space_members.standing` (`owner`, `member`, `guest`) says where someone stands: an owner is
//!   outside every rule, a guest under a hard ceiling. `expires_at` (guests only) and
//!   `expiry_notice_sent_at` are ready for the guests' lot.
//! - `space_roles` holds each space's roles and the permission names they grant. Three are system
//!   roles every space holds (`system_key`): `administrator` (today's `admin`), and the base roles
//!   `members` and `guests` that nobody is assigned, the standing implying them.
//! - `space_role_assignments` says who holds which role; leaving a space drops them.
//! - `permission_overrides` are the rules on a channel, a file or a calendar: a role or a person,
//!   permissions allowed and denied. Real foreign keys, so no rule outlives what it is about.
//!
//! **The old columns stay the ones written, and the database derives the new model from them.**
//! `space_members.role`, `channel_role_access` and `calendars.write_access` keep being written by
//! the code, as before, so the previous image can restart on the same data. Triggers turn each of
//! those writes into the new model at once: a standing and the Administrator role from `role`, rules
//! from a reservation or a calendar closed to members, the system roles for a new space. Whoever
//! writes (this version, the previous one after a rollback, the importer, the seed, a test), the two
//! models cannot drift apart. The triggers only ever touch the bits they own (`channel.view` and
//! `calendar.write` on the system roles' rules), so rules written later by other means survive.
//!
//! [`convert`] derives the new model from the old one for every space, which is what this migration
//! does to the data it finds; it is safe to run again.

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};

#[derive(DeriveMigrationName)]
pub struct Migration;

/// Every permission of the catalogue (`apps/api/src/permissions/catalogue.rs`), in its order.
macro_rules! all_permissions {
    () => {
        "ARRAY['space.settings', 'members.view', 'members.invite', 'members.manage', \
         'roles.manage', 'groups.manage', 'audit.view', 'channels.create', 'channels.delete', \
         'calendars.create', 'dm.start', 'files.trash.purge', 'channel.view', 'message.send', \
         'message.react', 'message.attach', 'message.mention_all', 'message.pin', \
         'message.manage', 'channel.members.manage', 'channel.manage', 'files.view', \
         'files.create', 'files.edit', 'files.manage', 'files.public_link', 'calendar.view', \
         'calendar.write', 'calendar.manage']::text[]"
    };
}

/// What `@members` holds: everything a plain member could do before roles existed.
macro_rules! members_base {
    () => {
        "ARRAY['members.view', 'channels.create', 'dm.start', 'channel.view', 'message.send', \
         'message.react', 'message.attach', 'message.mention_all', 'message.pin', 'files.view', \
         'files.create', 'files.edit', 'calendar.view', 'calendar.write']::text[]"
    };
}

/// What `@guests` holds: taking part where they were let in, nothing space-wide.
macro_rules! guests_base {
    () => {
        "ARRAY['dm.start', 'message.send', 'message.react', 'message.attach', \
         'message.mention_all']::text[]"
    };
}

// A space's own roles have unique names (`space_roles_name_key`, among roles without a
// `system_key`); a system role is known by its key, so no role named like it can ever stop it from
// being created again.
const SCHEMA: &str = "\
ALTER TABLE space_members \
    ADD COLUMN standing text, \
    ADD COLUMN expires_at timestamptz, \
    ADD COLUMN expiry_notice_sent_at timestamptz; \
UPDATE space_members SET standing = CASE role WHEN 'owner' THEN 'owner' WHEN 'guest' THEN 'guest' ELSE 'member' END; \
ALTER TABLE space_members \
    ALTER COLUMN standing SET NOT NULL, \
    ADD CONSTRAINT space_members_standing_check CHECK (standing IN ('owner', 'member', 'guest')), \
    ADD CONSTRAINT space_members_expiry_check CHECK (expires_at IS NULL OR standing = 'guest'); \
\
ALTER TABLE channels ADD CONSTRAINT channels_id_space_key UNIQUE (id, space_id); \
ALTER TABLE files ADD CONSTRAINT files_id_space_key UNIQUE (id, space_id); \
ALTER TABLE calendars ADD CONSTRAINT calendars_id_space_key UNIQUE (id, space_id); \
\
CREATE TABLE space_roles ( \
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), \
    space_id uuid NOT NULL REFERENCES spaces (id) ON DELETE CASCADE, \
    system_key text CHECK (system_key IN ('administrator', 'members', 'guests')), \
    name citext NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100), \
    colour text CHECK (colour IN ('sky', 'mint', 'violet', 'pink', 'peach', 'lime', 'sun', 'accent')), \
    position integer NOT NULL DEFAULT 0, \
    permissions text[] NOT NULL DEFAULT '{}', \
    created_by uuid REFERENCES users (id) ON DELETE SET NULL, \
    created_at timestamptz NOT NULL DEFAULT now(), \
    updated_at timestamptz NOT NULL DEFAULT now(), \
    CONSTRAINT space_roles_system_key UNIQUE (space_id, system_key), \
    CONSTRAINT space_roles_id_space_key UNIQUE (id, space_id) \
); \
CREATE UNIQUE INDEX space_roles_name_key ON space_roles (space_id, name) WHERE system_key IS NULL; \
\
CREATE TABLE space_role_assignments ( \
    space_id uuid NOT NULL, \
    user_id uuid NOT NULL, \
    role_id uuid NOT NULL, \
    PRIMARY KEY (role_id, user_id), \
    FOREIGN KEY (space_id, user_id) REFERENCES space_members (space_id, user_id) ON DELETE CASCADE, \
    FOREIGN KEY (role_id, space_id) REFERENCES space_roles (id, space_id) ON DELETE CASCADE \
); \
CREATE INDEX space_role_assignments_member ON space_role_assignments (space_id, user_id); \
\
CREATE TABLE permission_overrides ( \
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), \
    space_id uuid NOT NULL REFERENCES spaces (id) ON DELETE CASCADE, \
    channel_id uuid, \
    file_id uuid, \
    calendar_id uuid, \
    role_id uuid, \
    user_id uuid, \
    allow text[] NOT NULL DEFAULT '{}', \
    deny text[] NOT NULL DEFAULT '{}', \
    created_by uuid REFERENCES users (id) ON DELETE SET NULL, \
    created_at timestamptz NOT NULL DEFAULT now(), \
    updated_at timestamptz NOT NULL DEFAULT now(), \
    FOREIGN KEY (channel_id, space_id) REFERENCES channels (id, space_id) ON DELETE CASCADE, \
    FOREIGN KEY (file_id, space_id) REFERENCES files (id, space_id) ON DELETE CASCADE, \
    FOREIGN KEY (calendar_id, space_id) REFERENCES calendars (id, space_id) ON DELETE CASCADE, \
    FOREIGN KEY (role_id, space_id) REFERENCES space_roles (id, space_id) ON DELETE CASCADE, \
    FOREIGN KEY (space_id, user_id) REFERENCES space_members (space_id, user_id) ON DELETE CASCADE, \
    CONSTRAINT permission_overrides_one_resource CHECK (num_nonnulls(channel_id, file_id, calendar_id) = 1), \
    CONSTRAINT permission_overrides_one_target CHECK (num_nonnulls(role_id, user_id) = 1) \
); \
CREATE INDEX permission_overrides_space ON permission_overrides (space_id); \
CREATE UNIQUE INDEX permission_overrides_channel_role ON permission_overrides (channel_id, role_id) \
    WHERE channel_id IS NOT NULL AND role_id IS NOT NULL; \
CREATE UNIQUE INDEX permission_overrides_channel_user ON permission_overrides (channel_id, user_id) \
    WHERE channel_id IS NOT NULL AND user_id IS NOT NULL; \
CREATE UNIQUE INDEX permission_overrides_file_role ON permission_overrides (file_id, role_id) \
    WHERE file_id IS NOT NULL AND role_id IS NOT NULL; \
CREATE UNIQUE INDEX permission_overrides_file_user ON permission_overrides (file_id, user_id) \
    WHERE file_id IS NOT NULL AND user_id IS NOT NULL; \
CREATE UNIQUE INDEX permission_overrides_calendar_role ON permission_overrides (calendar_id, role_id) \
    WHERE calendar_id IS NOT NULL AND role_id IS NOT NULL; \
CREATE UNIQUE INDEX permission_overrides_calendar_user ON permission_overrides (calendar_id, user_id) \
    WHERE calendar_id IS NOT NULL AND user_id IS NOT NULL; \
";

/// The functions the triggers and [`convert`] share.
fn functions() -> String {
    format!(
        r#"
CREATE OR REPLACE FUNCTION permissions_ensure_system_roles(p_space uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO space_roles (space_id, system_key, name, position, permissions)
    VALUES (p_space, 'administrator', 'Administrator', 100, {all}),
           (p_space, 'members', '@members', 0, {members}),
           (p_space, 'guests', '@guests', -1, {guests})
    ON CONFLICT (space_id, system_key) DO NOTHING;
END $$;

-- Put one permission in a system role's rule on a channel or a calendar, allowed or denied.
CREATE OR REPLACE FUNCTION permissions_system_rule(p_space uuid, p_channel uuid, p_calendar uuid,
                                        p_key text, p_permission text, p_allow boolean)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_role uuid;
    v_allow text[] := CASE WHEN p_allow THEN ARRAY[p_permission] ELSE '{{}}'::text[] END;
    v_deny text[] := CASE WHEN p_allow THEN '{{}}'::text[] ELSE ARRAY[p_permission] END;
BEGIN
    SELECT id INTO v_role FROM space_roles WHERE space_id = p_space AND system_key = p_key;
    IF p_channel IS NOT NULL THEN
        INSERT INTO permission_overrides (space_id, channel_id, role_id, allow, deny)
        VALUES (p_space, p_channel, v_role, v_allow, v_deny)
        ON CONFLICT (channel_id, role_id) WHERE channel_id IS NOT NULL AND role_id IS NOT NULL
        DO UPDATE SET
            allow = array_remove(permission_overrides.allow, p_permission) || v_allow,
            deny = array_remove(permission_overrides.deny, p_permission) || v_deny,
            updated_at = now();
    ELSE
        INSERT INTO permission_overrides (space_id, calendar_id, role_id, allow, deny)
        VALUES (p_space, p_calendar, v_role, v_allow, v_deny)
        ON CONFLICT (calendar_id, role_id) WHERE calendar_id IS NOT NULL AND role_id IS NOT NULL
        DO UPDATE SET
            allow = array_remove(permission_overrides.allow, p_permission) || v_allow,
            deny = array_remove(permission_overrides.deny, p_permission) || v_deny,
            updated_at = now();
    END IF;
END $$;

-- A channel's reservation (`channel_role_access`) as rules on the system roles: members and
-- guests denied the view when not named, the Administrator role allowed or denied it.
CREATE OR REPLACE FUNCTION permissions_sync_reservation(p_channel uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_space uuid;
    v_roles text[];
BEGIN
    SELECT space_id INTO v_space FROM channels WHERE id = p_channel;
    IF v_space IS NULL THEN
        RETURN;
    END IF;
    PERFORM permissions_ensure_system_roles(v_space);
    UPDATE permission_overrides o
       SET allow = array_remove(o.allow, 'channel.view'),
           deny = array_remove(o.deny, 'channel.view'),
           updated_at = now()
      FROM space_roles r
     WHERE o.channel_id = p_channel AND o.role_id = r.id AND r.system_key IS NOT NULL
       AND ('channel.view' = ANY (o.allow) OR 'channel.view' = ANY (o.deny));
    SELECT coalesce(array_agg(role), '{{}}') INTO v_roles
      FROM channel_role_access WHERE channel_id = p_channel;
    IF cardinality(v_roles) > 0 THEN
        IF NOT 'member' = ANY (v_roles) THEN
            PERFORM permissions_system_rule(v_space, p_channel, NULL, 'members', 'channel.view', false);
        END IF;
        IF NOT 'guest' = ANY (v_roles) THEN
            PERFORM permissions_system_rule(v_space, p_channel, NULL, 'guests', 'channel.view', false);
        END IF;
        PERFORM permissions_system_rule(v_space, p_channel, NULL, 'administrator', 'channel.view',
                                        'admin' = ANY (v_roles));
    END IF;
    DELETE FROM permission_overrides o USING space_roles r
     WHERE o.channel_id = p_channel AND o.role_id = r.id AND r.system_key IS NOT NULL
       AND cardinality(o.allow) = 0 AND cardinality(o.deny) = 0;
END $$;

-- A space calendar closed to members (`write_access = 'admins'`) as rules on the system roles.
CREATE OR REPLACE FUNCTION permissions_sync_calendar(p_calendar uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_space uuid;
    v_write text;
BEGIN
    SELECT space_id, write_access INTO v_space, v_write FROM calendars WHERE id = p_calendar;
    IF v_space IS NULL THEN
        RETURN;
    END IF;
    PERFORM permissions_ensure_system_roles(v_space);
    UPDATE permission_overrides o
       SET allow = array_remove(o.allow, 'calendar.write'),
           deny = array_remove(o.deny, 'calendar.write'),
           updated_at = now()
      FROM space_roles r
     WHERE o.calendar_id = p_calendar AND o.role_id = r.id AND r.system_key IS NOT NULL
       AND ('calendar.write' = ANY (o.allow) OR 'calendar.write' = ANY (o.deny));
    IF v_write = 'admins' THEN
        PERFORM permissions_system_rule(v_space, NULL, p_calendar, 'members', 'calendar.write', false);
        PERFORM permissions_system_rule(v_space, NULL, p_calendar, 'administrator', 'calendar.write', true);
    END IF;
    DELETE FROM permission_overrides o USING space_roles r
     WHERE o.calendar_id = p_calendar AND o.role_id = r.id AND r.system_key IS NOT NULL
       AND cardinality(o.allow) = 0 AND cardinality(o.deny) = 0;
END $$;

-- Everything the new model holds about one space, derived again from the old columns.
CREATE OR REPLACE FUNCTION permissions_convert_space(p_space uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM permissions_ensure_system_roles(p_space);
    UPDATE space_members m
       SET standing = d.standing,
           expires_at = CASE WHEN d.standing = 'guest' THEN m.expires_at END,
           expiry_notice_sent_at = CASE WHEN d.standing = 'guest' THEN m.expiry_notice_sent_at END
      FROM (SELECT user_id,
                   CASE role WHEN 'owner' THEN 'owner' WHEN 'guest' THEN 'guest' ELSE 'member' END
                       AS standing
              FROM space_members WHERE space_id = p_space) d
     WHERE m.space_id = p_space AND m.user_id = d.user_id AND m.standing IS DISTINCT FROM d.standing;
    INSERT INTO space_role_assignments (space_id, user_id, role_id)
    SELECT m.space_id, m.user_id, r.id
      FROM space_members m
      JOIN space_roles r ON r.space_id = m.space_id AND r.system_key = 'administrator'
     WHERE m.space_id = p_space AND m.role = 'admin'
    ON CONFLICT DO NOTHING;
    DELETE FROM space_role_assignments a
     USING space_roles r, space_members m
     WHERE a.role_id = r.id AND r.system_key = 'administrator' AND r.space_id = p_space
       AND m.space_id = a.space_id AND m.user_id = a.user_id AND m.role <> 'admin';
    PERFORM permissions_sync_reservation(id) FROM channels WHERE space_id = p_space;
    PERFORM permissions_sync_calendar(id) FROM calendars WHERE space_id = p_space;
END $$;

CREATE OR REPLACE FUNCTION permissions_on_space() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM permissions_ensure_system_roles(NEW.id);
    RETURN NULL;
END $$;

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

CREATE OR REPLACE FUNCTION permissions_member_roles() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_admin uuid;
BEGIN
    IF NEW.role = 'admin' THEN
        PERFORM permissions_ensure_system_roles(NEW.space_id);
    END IF;
    SELECT id INTO v_admin FROM space_roles
     WHERE space_id = NEW.space_id AND system_key = 'administrator';
    IF NEW.role = 'admin' THEN
        INSERT INTO space_role_assignments (space_id, user_id, role_id)
        VALUES (NEW.space_id, NEW.user_id, v_admin)
        ON CONFLICT DO NOTHING;
    ELSE
        DELETE FROM space_role_assignments WHERE role_id = v_admin AND user_id = NEW.user_id;
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION permissions_on_reservation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'DELETE' THEN
        PERFORM permissions_sync_reservation(NEW.channel_id);
    END IF;
    IF TG_OP <> 'INSERT' THEN
        PERFORM permissions_sync_reservation(OLD.channel_id);
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION permissions_on_calendar() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM permissions_sync_calendar(NEW.id);
    RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER spaces_system_roles AFTER INSERT ON spaces
    FOR EACH ROW EXECUTE FUNCTION permissions_on_space();
CREATE OR REPLACE TRIGGER space_members_standing BEFORE INSERT OR UPDATE OF role ON space_members
    FOR EACH ROW EXECUTE FUNCTION permissions_member_standing();
CREATE OR REPLACE TRIGGER space_members_roles AFTER INSERT OR UPDATE OF role ON space_members
    FOR EACH ROW EXECUTE FUNCTION permissions_member_roles();
CREATE OR REPLACE TRIGGER channel_role_access_rules AFTER INSERT OR UPDATE OR DELETE ON channel_role_access
    FOR EACH ROW EXECUTE FUNCTION permissions_on_reservation();
CREATE OR REPLACE TRIGGER calendars_write_rules AFTER INSERT OR UPDATE OF write_access ON calendars
    FOR EACH ROW EXECUTE FUNCTION permissions_on_calendar();
"#,
        all = all_permissions!(),
        members = members_base!(),
        guests = guests_base!(),
    )
}

const DOWN: &str = "\
DROP TRIGGER IF EXISTS calendars_write_rules ON calendars; \
DROP TRIGGER IF EXISTS channel_role_access_rules ON channel_role_access; \
DROP TRIGGER IF EXISTS space_members_roles ON space_members; \
DROP TRIGGER IF EXISTS space_members_standing ON space_members; \
DROP TRIGGER IF EXISTS spaces_system_roles ON spaces; \
DROP FUNCTION IF EXISTS permissions_on_calendar(); \
DROP FUNCTION IF EXISTS permissions_on_reservation(); \
DROP FUNCTION IF EXISTS permissions_member_roles(); \
DROP FUNCTION IF EXISTS permissions_member_standing(); \
DROP FUNCTION IF EXISTS permissions_on_space(); \
DROP FUNCTION IF EXISTS permissions_convert_space(uuid); \
DROP FUNCTION IF EXISTS permissions_sync_calendar(uuid); \
DROP FUNCTION IF EXISTS permissions_sync_reservation(uuid); \
DROP FUNCTION IF EXISTS permissions_system_rule(uuid, uuid, uuid, text, text, boolean); \
DROP FUNCTION IF EXISTS permissions_ensure_system_roles(uuid); \
DROP TABLE IF EXISTS permission_overrides; \
DROP TABLE IF EXISTS space_role_assignments; \
DROP TABLE IF EXISTS space_roles; \
ALTER TABLE calendars DROP CONSTRAINT IF EXISTS calendars_id_space_key; \
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_id_space_key; \
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_id_space_key; \
ALTER TABLE space_members \
    DROP CONSTRAINT IF EXISTS space_members_expiry_check, \
    DROP CONSTRAINT IF EXISTS space_members_standing_check, \
    DROP COLUMN IF EXISTS expiry_notice_sent_at, \
    DROP COLUMN IF EXISTS expires_at, \
    DROP COLUMN IF EXISTS standing; \
";

/// Derive the new model from the old columns for every space: what this migration does to the
/// data it finds. Safe to run again: a space already in step is left as it is.
pub async fn convert<C: ConnectionTrait>(db: &C) -> Result<(), DbErr> {
    db.execute_unprepared("SELECT permissions_convert_space(id) FROM spaces;")
        .await?;
    Ok(())
}

/// [`convert`] for one space.
pub async fn convert_space<C: ConnectionTrait>(db: &C, space_id: uuid::Uuid) -> Result<(), DbErr> {
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT permissions_convert_space($1::uuid)",
        [space_id.to_string().into()],
    ))
    .await?;
    Ok(())
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(SCHEMA).await?;
        db.execute_unprepared(&functions()).await?;
        convert(db).await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(DOWN).await?;
        Ok(())
    }
}
