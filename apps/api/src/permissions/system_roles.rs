//! The system roles every space holds, and the two fixed sets that make a guest a guest.
//!
//! The database creates the three roles itself (the `permissions_ensure_system_roles` function of
//! the permission foundation migration, called when a space is inserted), with the sets below
//! written out as names; `the_system_roles_hold_the_constants` holds the two to the same values.

use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, DbErr, EntityTrait, QueryFilter, Statement,
};
use uuid::Uuid;

use super::catalogue::{Permission, PermissionSet};
use crate::entities::space_roles;

/// What `@members` holds: everything a plain member could do before roles existed.
pub const MEMBERS_BASE: PermissionSet = PermissionSet::of(&[
    Permission::MembersView,
    Permission::ChannelsCreate,
    Permission::DmStart,
    Permission::ChannelView,
    Permission::MessageSend,
    Permission::MessageReact,
    Permission::MessageAttach,
    Permission::MessageMentionAll,
    Permission::MessagePin,
    Permission::FilesView,
    Permission::FilesCreate,
    Permission::FilesEdit,
    Permission::CalendarView,
    Permission::CalendarWrite,
]);

/// What `@guests` holds: taking part where they were let in, nothing space-wide.
pub const GUESTS_BASE: PermissionSet = PermissionSet::of(&[
    Permission::DmStart,
    Permission::MessageSend,
    Permission::MessageReact,
    Permission::MessageAttach,
    Permission::MessageMentionAll,
]);

/// The Administrator role: today's `admin`, every permission of the catalogue.
pub const ADMINISTRATOR: PermissionSet = PermissionSet::ALL;

/// The ids of a space's three system roles.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SystemRoles {
    pub administrator: Uuid,
    pub members: Uuid,
    pub guests: Uuid,
}

/// The space's system roles, created first if any is missing (a space written before the
/// foundation, or by hand). Concurrent callers are safe: the database inserts with
/// `ON CONFLICT DO NOTHING`, and everyone reads the rows that won.
pub async fn ensure_system_roles<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
) -> Result<SystemRoles, DbErr> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT permissions_ensure_system_roles($1)",
        [space_id.into()],
    ))
    .await?;
    let roles = space_roles::Entity::find()
        .filter(space_roles::Column::SpaceId.eq(space_id))
        .filter(space_roles::Column::SystemKey.is_not_null())
        .all(db)
        .await?;
    let id_of = |key: &str| {
        roles
            .iter()
            .find(|role| role.system_key.as_deref() == Some(key))
            .map(|role| role.id)
            .ok_or_else(|| DbErr::RecordNotFound(format!("the {key} role of space {space_id}")))
    };
    Ok(SystemRoles {
        administrator: id_of("administrator")?,
        members: id_of("members")?,
        guests: id_of("guests")?,
    })
}

/// What no rule, role or setting can ever give a guest (spec section 4, the "never" column).
pub const GUEST_CEILING: PermissionSet = PermissionSet::of(&[
    Permission::SpaceSettings,
    Permission::MembersView,
    Permission::MembersInvite,
    Permission::MembersManage,
    Permission::RolesManage,
    Permission::GroupsManage,
    Permission::AuditView,
    Permission::ChannelsCreate,
    Permission::ChannelsDelete,
    Permission::CalendarsCreate,
    Permission::FilesTrashPurge,
    Permission::MessageManage,
    Permission::ChannelMembersManage,
    Permission::ChannelManage,
    Permission::FilesManage,
    Permission::FilesPublicLink,
    Permission::CalendarManage,
]);

/// The space-wide visibility a guest starts without: they reach a channel, a file or a calendar
/// only where a membership or a rule opens it, and see only the people they share a conversation
/// with.
pub const VISIBILITY_DROP: PermissionSet = PermissionSet::of(&[
    Permission::ChannelView,
    Permission::FilesView,
    Permission::FilesCreate,
    Permission::FilesEdit,
    Permission::CalendarView,
    Permission::CalendarWrite,
    Permission::MembersView,
]);
