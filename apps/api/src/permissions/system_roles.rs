//! The system roles every space holds, and the two fixed sets that make a guest a guest.
//!
//! The database creates the three roles itself (the `permissions_ensure_system_roles` function of
//! the permission foundation migration, called when a space is inserted), with the sets below
//! written out as names; `the_system_roles_hold_the_constants` holds the two to the same values
//! (which is all the code reads these three sets for until roles are edited, in lot 2).

use super::catalogue::{Permission, PermissionSet};

/// What `@members` holds: everything a plain member could do before roles existed.
#[cfg_attr(not(test), allow(dead_code))]
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
#[cfg_attr(not(test), allow(dead_code))]
pub const GUESTS_BASE: PermissionSet = PermissionSet::of(&[
    Permission::DmStart,
    Permission::MessageSend,
    Permission::MessageReact,
    Permission::MessageAttach,
    Permission::MessageMentionAll,
]);

/// The Administrator role: today's `admin`, every permission of the catalogue.
#[cfg_attr(not(test), allow(dead_code))]
pub const ADMINISTRATOR: PermissionSet = PermissionSet::ALL;

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
