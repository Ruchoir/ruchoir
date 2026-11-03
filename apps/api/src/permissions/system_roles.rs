//! The system roles every space holds, and the two fixed sets that make a guest a guest.

use super::catalogue::{Permission, PermissionSet};

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
