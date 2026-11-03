//! The permission catalogue: every right a person can hold in a space, by name.
//!
//! A permission is stored by its name (`text[]` columns) and held in memory as one bit of a `u64`
//! ([`PermissionSet`]). Two rules keep both forms trustworthy across versions:
//!
//! - **A name is never renamed or removed, and a position never moves.** The bit a permission
//!   occupies is its discriminant, so reordering the enum would silently hand one right's holders
//!   another. `the_permission_catalogue_only_grows` checks both against
//!   `apps/api/contract/permissions-v1.json`.
//! - **An unknown name opens nothing.** A newer version may write a name this one does not know (a
//!   rollback); [`PermissionSet::from_names`] skips it rather than guessing a bit for it.

/// The four families a permission belongs to, which say what kind of resource it can be set on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Family {
    Space,
    Channel,
    Files,
    Calendar,
}

macro_rules! catalogue {
    ($($variant:ident = $name:literal, $family:ident, $resource:literal;)*) => {
        /// One right, as the catalogue names it (spec section 4). The discriminant is the bit.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        #[repr(u8)]
        pub enum Permission {
            $($variant,)*
        }

        impl Permission {
            /// Every permission, in catalogue order (which is bit order).
            pub const ALL: [Permission; catalogue!(@count $($variant)*)] = [$(Permission::$variant,)*];

            /// The stored and published name, `family.action`.
            // Published by `my_permissions` (TEMP: allow removed with it, permissions lot 1 Task 11).
            #[cfg_attr(not(test), allow(dead_code))]
            pub fn name(self) -> &'static str {
                match self {
                    $(Permission::$variant => $name,)*
                }
            }

            /// The permission a name stands for, or `None` for a name this version does not know.
            pub fn parse(name: &str) -> Option<Permission> {
                match name {
                    $($name => Some(Permission::$variant),)*
                    _ => None,
                }
            }

            /// What kind of resource the permission is about.
            pub fn family(self) -> Family {
                match self {
                    $(Permission::$variant => Family::$family,)*
                }
            }

            /// Whether a rule on a channel, folder, file or calendar may set it. The space-wide
            /// ones (inviting, deleting channels, emptying the trash...) are only set on roles.
            // Read once rules are written by hand (permissions lot 4).
            #[allow(dead_code)]
            pub fn resource_level(self) -> bool {
                match self {
                    $(Permission::$variant => $resource,)*
                }
            }
        }
    };
    (@count) => { 0 };
    (@count $head:ident $($tail:ident)*) => { 1 + catalogue!(@count $($tail)*) };
}

catalogue! {
    SpaceSettings = "space.settings", Space, false;
    MembersView = "members.view", Space, false;
    MembersInvite = "members.invite", Space, false;
    MembersManage = "members.manage", Space, false;
    RolesManage = "roles.manage", Space, false;
    GroupsManage = "groups.manage", Space, false;
    AuditView = "audit.view", Space, false;
    ChannelsCreate = "channels.create", Space, false;
    ChannelsDelete = "channels.delete", Space, false;
    CalendarsCreate = "calendars.create", Space, false;
    DmStart = "dm.start", Space, false;
    FilesTrashPurge = "files.trash.purge", Space, false;
    ChannelView = "channel.view", Channel, true;
    MessageSend = "message.send", Channel, true;
    MessageReact = "message.react", Channel, true;
    MessageAttach = "message.attach", Channel, true;
    MessageMentionAll = "message.mention_all", Channel, true;
    MessagePin = "message.pin", Channel, true;
    MessageManage = "message.manage", Channel, true;
    ChannelMembersManage = "channel.members.manage", Channel, true;
    ChannelManage = "channel.manage", Channel, true;
    FilesView = "files.view", Files, true;
    FilesCreate = "files.create", Files, true;
    FilesEdit = "files.edit", Files, true;
    FilesManage = "files.manage", Files, true;
    FilesPublicLink = "files.public_link", Files, true;
    CalendarView = "calendar.view", Calendar, true;
    CalendarWrite = "calendar.write", Calendar, true;
    CalendarManage = "calendar.manage", Calendar, true;
}

/// A set of permissions, one bit each. Copy, compared and combined in constant time, which is what
/// lets a whole space's channels be resolved in memory.
#[derive(Clone, Copy, Default, PartialEq, Eq, Hash, Debug)]
pub struct PermissionSet(u64);

impl PermissionSet {
    pub const EMPTY: PermissionSet = PermissionSet(0);
    pub const ALL: PermissionSet = PermissionSet((1u64 << Permission::ALL.len()) - 1);

    /// The set holding exactly these permissions.
    pub const fn of(permissions: &[Permission]) -> PermissionSet {
        let mut bits = 0u64;
        let mut index = 0;
        while index < permissions.len() {
            bits |= 1u64 << permissions[index] as u8;
            index += 1;
        }
        PermissionSet(bits)
    }

    pub fn contains(self, permission: Permission) -> bool {
        self.0 & (1u64 << permission as u8) != 0
    }

    pub fn insert(&mut self, permission: Permission) {
        self.0 |= 1u64 << permission as u8;
    }

    pub fn remove(&mut self, permission: Permission) {
        self.0 &= !(1u64 << permission as u8);
    }

    pub const fn union(self, other: PermissionSet) -> PermissionSet {
        PermissionSet(self.0 | other.0)
    }

    pub const fn minus(self, other: PermissionSet) -> PermissionSet {
        PermissionSet(self.0 & !other.0)
    }

    pub const fn intersect(self, other: PermissionSet) -> PermissionSet {
        PermissionSet(self.0 & other.0)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// Every permission of a family.
    pub fn of_family(family: Family) -> PermissionSet {
        let mut set = PermissionSet::EMPTY;
        for permission in Permission::ALL {
            if permission.family() == family {
                set.insert(permission);
            }
        }
        set
    }

    /// The permissions held, in catalogue order.
    pub fn iter(self) -> impl Iterator<Item = Permission> {
        Permission::ALL
            .into_iter()
            .filter(move |permission| self.contains(*permission))
    }

    /// The set a stored list of names stands for. A name this version does not know is skipped:
    /// it may come from a newer version after a rollback, and it can never open anything here.
    pub fn from_names(names: &[String]) -> PermissionSet {
        let mut set = PermissionSet::EMPTY;
        for permission in names.iter().filter_map(|name| Permission::parse(name)) {
            set.insert(permission);
        }
        set
    }

    /// The names to store or publish, in catalogue order.
    // Published by `my_permissions` (TEMP: allow removed with it, permissions lot 1 Task 11).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn to_names(self) -> Vec<String> {
        self.iter()
            .map(|permission| permission.name().to_owned())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_unique_and_round_trip() {
        let mut seen = std::collections::HashSet::new();
        for permission in Permission::ALL {
            assert_eq!(Permission::parse(permission.name()), Some(permission));
            assert!(
                seen.insert(permission.name()),
                "{} twice",
                permission.name()
            );
        }
        assert_eq!(seen.len(), 29);
        for (index, permission) in Permission::ALL.iter().enumerate() {
            assert_eq!(
                *permission as usize,
                index,
                "{} out of place",
                permission.name()
            );
        }
    }

    #[test]
    fn unknown_names_are_ignored() {
        let set = PermissionSet::from_names(&["channel.view".into(), "space.nuke".into()]);
        assert_eq!(set, PermissionSet::of(&[Permission::ChannelView]));
        assert_eq!(Permission::parse("space.nuke"), None);
        assert_eq!(set.to_names(), vec!["channel.view".to_owned()]);
    }

    #[test]
    fn set_algebra() {
        let a = PermissionSet::of(&[Permission::ChannelView, Permission::MessageSend]);
        let b = PermissionSet::of(&[Permission::MessageSend, Permission::FilesView]);
        assert_eq!(
            a.union(b),
            PermissionSet::of(&[
                Permission::ChannelView,
                Permission::MessageSend,
                Permission::FilesView
            ])
        );
        assert_eq!(a.minus(b), PermissionSet::of(&[Permission::ChannelView]));
        assert_eq!(
            a.intersect(b),
            PermissionSet::of(&[Permission::MessageSend])
        );
        let mut c = PermissionSet::EMPTY;
        c.insert(Permission::FilesView);
        assert!(c.contains(Permission::FilesView));
        c.remove(Permission::FilesView);
        assert_eq!(c, PermissionSet::EMPTY);
        assert_eq!(PermissionSet::ALL.iter().count(), 29);
        assert_eq!(
            PermissionSet::ALL.to_names(),
            Permission::ALL
                .iter()
                .map(|p| p.name().to_owned())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn families_and_levels() {
        assert_eq!(Permission::SpaceSettings.family(), Family::Space);
        assert_eq!(Permission::FilesTrashPurge.family(), Family::Space);
        assert_eq!(Permission::MessagePin.family(), Family::Channel);
        assert_eq!(Permission::FilesPublicLink.family(), Family::Files);
        assert_eq!(Permission::CalendarManage.family(), Family::Calendar);
        let space_only = Permission::ALL
            .iter()
            .filter(|p| !p.resource_level())
            .count();
        assert_eq!(space_only, 12);
        assert_eq!(PermissionSet::of_family(Family::Calendar).iter().count(), 3);
        assert_eq!(PermissionSet::of_family(Family::Files).iter().count(), 5);
        assert_eq!(PermissionSet::of_family(Family::Channel).iter().count(), 9);
    }

    /// A permission's name is stored in the database and read by apps: once recorded it never
    /// changes or goes, and its position in the bitset never moves. With `RUCHOIR_UPDATE_CONTRACT`
    /// set, the recorded list is rewritten from [`Permission::ALL`] (after the check, so a broken
    /// name can never be recorded over).
    #[test]
    fn the_permission_catalogue_only_grows() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/contract/permissions-v1.json");
        let recorded: Vec<String> = std::fs::read_to_string(path)
            .ok()
            .map(|text| serde_json::from_str(&text).expect("the recorded catalogue is JSON"))
            .unwrap_or_default();
        for (index, name) in recorded.iter().enumerate() {
            let parsed = Permission::parse(name)
                .unwrap_or_else(|| panic!("`{name}` left the catalogue: names are never removed"));
            assert_eq!(
                parsed as usize, index,
                "`{name}` moved: positions never change"
            );
        }
        let current: Vec<String> = Permission::ALL
            .iter()
            .map(|p| p.name().to_owned())
            .collect();
        if std::env::var_os("RUCHOIR_UPDATE_CONTRACT").is_some() {
            let mut text = serde_json::to_string_pretty(&current).expect("json");
            text.push('\n');
            std::fs::write(path, text).expect("write the catalogue");
            return;
        }
        assert_eq!(
            recorded, current,
            "the catalogue grew: record it with `RUCHOIR_UPDATE_CONTRACT=1 cargo test -p ruchoir-api the_permission_catalogue_only_grows`"
        );
    }
}
