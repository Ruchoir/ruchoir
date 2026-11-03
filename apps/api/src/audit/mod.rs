//! A space's audit log (design section 6): who changed which rights, when, and what they were
//! before and after. Free, in every edition; read in the space settings by whoever holds
//! `audit.view`.
//!
//! **Append-only.** [`record`] is the only code that writes it (`no_code_writes_to_the_audit_log_but_record`
//! holds every other file to that), and the database refuses any change but its own: a deleted
//! account leaves its entries anonymous (`actor_id` set to NULL), a deleted space takes its log.
//! Tamper-evidence and export belong to the enterprise edition (RUC-6).
//!
//! `details` carries ids, role names and permission names, before and after; never a person's
//! name (it is read at display time, so a deleted account reads as one) and never any content.

pub mod read;

use sea_orm::{ConnectionTrait, DbBackend, DbErr, Statement};
use uuid::Uuid;

/// What happened. The dotted name is what is stored, and never changes once written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Someone arrived in the space (an invitation accepted).
    MemberJoined,
    /// Someone left the space on their own.
    MemberLeft,
    /// Someone was taken out of the space.
    MemberRemoved,
    /// A person's fixed role changed (`owner`, `admin`, `member`, `guest`).
    MemberRoleChanged,
    /// The space was handed over to another owner.
    OwnershipTransferred,
    /// A person's roles changed (custom roles, Administrator).
    MemberRolesChanged,
    RoleCreated,
    RoleUpdated,
    RoleDeleted,
    RolesReordered,
    /// A channel's reservation to some roles changed.
    ChannelReserved,
    /// Who may write in a space calendar changed.
    CalendarWriteAccessChanged,
    LicenceInstalled,
    LicenceRemoved,
}

impl Action {
    /// Every action, for the read filter and its tests.
    pub const ALL: [Action; 14] = [
        Action::MemberJoined,
        Action::MemberLeft,
        Action::MemberRemoved,
        Action::MemberRoleChanged,
        Action::OwnershipTransferred,
        Action::MemberRolesChanged,
        Action::RoleCreated,
        Action::RoleUpdated,
        Action::RoleDeleted,
        Action::RolesReordered,
        Action::ChannelReserved,
        Action::CalendarWriteAccessChanged,
        Action::LicenceInstalled,
        Action::LicenceRemoved,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Action::MemberJoined => "member.joined",
            Action::MemberLeft => "member.left",
            Action::MemberRemoved => "member.removed",
            Action::MemberRoleChanged => "member.role_changed",
            Action::OwnershipTransferred => "space.ownership_transferred",
            Action::MemberRolesChanged => "member.roles_changed",
            Action::RoleCreated => "role.created",
            Action::RoleUpdated => "role.updated",
            Action::RoleDeleted => "role.deleted",
            Action::RolesReordered => "roles.reordered",
            Action::ChannelReserved => "channel.reserved",
            Action::CalendarWriteAccessChanged => "calendar.write_access_changed",
            Action::LicenceInstalled => "licence.installed",
            Action::LicenceRemoved => "licence.removed",
        }
    }

    /// The family the screen filters by: `members`, `roles`, `channels`, `calendars`, `licence`.
    pub fn category(self) -> &'static str {
        match self {
            Action::MemberJoined
            | Action::MemberLeft
            | Action::MemberRemoved
            | Action::MemberRoleChanged
            | Action::OwnershipTransferred
            | Action::MemberRolesChanged => "members",
            Action::RoleCreated
            | Action::RoleUpdated
            | Action::RoleDeleted
            | Action::RolesReordered => "roles",
            Action::ChannelReserved => "channels",
            Action::CalendarWriteAccessChanged => "calendars",
            Action::LicenceInstalled | Action::LicenceRemoved => "licence",
        }
    }
}

/// What it happened to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Member(Uuid),
    Role(Uuid),
    Channel(Uuid),
    Calendar(Uuid),
    Space,
    Licence,
}

impl Target {
    fn kind(self) -> &'static str {
        match self {
            Target::Member(_) => "member",
            Target::Role(_) => "role",
            Target::Channel(_) => "channel",
            Target::Calendar(_) => "calendar",
            Target::Space => "space",
            Target::Licence => "licence",
        }
    }

    fn id(self) -> Option<Uuid> {
        match self {
            Target::Member(id) | Target::Role(id) | Target::Channel(id) | Target::Calendar(id) => {
                Some(id)
            }
            Target::Space | Target::Licence => None,
        }
    }
}

/// Write one entry, inside the caller's transaction when it passes one: the entry and the change it
/// describes are committed together or not at all.
pub async fn record(
    db: &impl ConnectionTrait,
    space_id: Uuid,
    actor: Option<Uuid>,
    action: Action,
    target: Target,
    details: serde_json::Value,
) -> Result<(), DbErr> {
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO space_audit_log (space_id, actor_id, action, target_kind, target_id, details) \
         VALUES ($1, $2, $3, $4, $5, $6)",
        [
            space_id.into(),
            actor.into(),
            action.as_str().into(),
            target.kind().into(),
            target.id().into(),
            details.into(),
        ],
    ))
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Action;

    #[test]
    fn action_names_are_distinct_and_dotted() {
        let mut names: Vec<&str> = Action::ALL.iter().map(|a| a.as_str()).collect();
        assert!(names.iter().all(|n| n.contains('.')));
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), Action::ALL.len());
    }
}
