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
    /// A guest's end date passed: they are no longer in the space (done by the sweep, no actor).
    MemberExpired,
    /// An ended guest's row was removed after ninety days (done by the sweep, no actor).
    MemberPurged,
    /// A guest's end date was set, moved or removed (`before`, `after`; `null` for no end).
    MemberExpirySet,
    /// An ended guest got their access back (`before`, `after`: the end that had passed, the new one).
    MemberReactivated,
    /// Someone became a guest, or stopped being one (`before`, `after`: `guest`, `member`, `owner`).
    MemberStandingChanged,
    /// The space was handed over to another owner.
    OwnershipTransferred,
    /// A person's roles changed (custom roles, Administrator).
    MemberRolesChanged,
    RoleCreated,
    RoleUpdated,
    RoleDeleted,
    RolesReordered,
    /// Somebody started, or left, the read only view of the space as a role. Payload
    /// `{ "role_id": uuid, "role_name": string, "phase": "started" | "ended" }`, plus
    /// `"reason": "quit" | "signed_out"` on an "ended" line. Started and quit by the edition; the
    /// core writes the sign-out one. An idle end is not logged.
    RolePreviewed,
    /// A channel's reservation to some roles changed.
    ChannelReserved,
    /// Who may write in a space calendar changed.
    CalendarWriteAccessChanged,
    LicenceInstalled,
    LicenceRemoved,
    GroupCreated,
    GroupUpdated,
    GroupDeleted,
    /// People were put in a group.
    GroupMembersAdded,
    /// People were taken out of a group, or left it.
    GroupMembersRemoved,
    /// The roles a group carries changed.
    GroupRolesChanged,
    /// Who manages a group changed.
    GroupManagersChanged,
    /// A rule on a channel, file or calendar was added.
    RuleCreated,
    RuleUpdated,
    RuleDeleted,
    /// People were brought over from another product. Payload: `{ source, job_id,
    /// administrators, guests, groups, moderators, custom_roles, fallbacks }`.
    ImportApplied,
}

impl Action {
    /// Every action, for the read filter and its tests.
    pub const ALL: [Action; 31] = [
        Action::MemberJoined,
        Action::MemberLeft,
        Action::MemberRemoved,
        Action::MemberRoleChanged,
        Action::MemberExpired,
        Action::MemberPurged,
        Action::MemberExpirySet,
        Action::MemberReactivated,
        Action::MemberStandingChanged,
        Action::OwnershipTransferred,
        Action::MemberRolesChanged,
        Action::RoleCreated,
        Action::RoleUpdated,
        Action::RoleDeleted,
        Action::RolesReordered,
        Action::RolePreviewed,
        Action::ChannelReserved,
        Action::CalendarWriteAccessChanged,
        Action::LicenceInstalled,
        Action::LicenceRemoved,
        Action::GroupCreated,
        Action::GroupUpdated,
        Action::GroupDeleted,
        Action::GroupMembersAdded,
        Action::GroupMembersRemoved,
        Action::GroupRolesChanged,
        Action::GroupManagersChanged,
        Action::RuleCreated,
        Action::RuleUpdated,
        Action::RuleDeleted,
        Action::ImportApplied,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Action::MemberJoined => "member.joined",
            Action::MemberLeft => "member.left",
            Action::MemberRemoved => "member.removed",
            Action::MemberRoleChanged => "member.role_changed",
            Action::MemberExpired => "member.expired",
            Action::MemberPurged => "member.purged",
            Action::MemberExpirySet => "member.expiry_set",
            Action::MemberReactivated => "member.reactivated",
            Action::MemberStandingChanged => "member.standing_changed",
            Action::OwnershipTransferred => "space.ownership_transferred",
            Action::MemberRolesChanged => "member.roles_changed",
            Action::RoleCreated => "role.created",
            Action::RoleUpdated => "role.updated",
            Action::RoleDeleted => "role.deleted",
            Action::RolesReordered => "roles.reordered",
            Action::RolePreviewed => "role.previewed",
            Action::ChannelReserved => "channel.reserved",
            Action::CalendarWriteAccessChanged => "calendar.write_access_changed",
            Action::LicenceInstalled => "licence.installed",
            Action::LicenceRemoved => "licence.removed",
            Action::GroupCreated => "group.created",
            Action::GroupUpdated => "group.updated",
            Action::GroupDeleted => "group.deleted",
            Action::GroupMembersAdded => "group.members_added",
            Action::GroupMembersRemoved => "group.members_removed",
            Action::GroupRolesChanged => "group.roles_changed",
            Action::GroupManagersChanged => "group.managers_changed",
            Action::RuleCreated => "rule.created",
            Action::RuleUpdated => "rule.updated",
            Action::RuleDeleted => "rule.deleted",
            Action::ImportApplied => "import.applied",
        }
    }

    /// The family the screen filters by: `members`, `guests`, `roles`, `groups`, `channels`, `calendars`, `licence`, `access`.
    pub fn category(self) -> &'static str {
        match self {
            Action::MemberJoined
            | Action::MemberLeft
            | Action::MemberRemoved
            | Action::MemberRoleChanged
            | Action::OwnershipTransferred
            | Action::MemberRolesChanged
            | Action::ImportApplied => "members",
            Action::MemberExpired
            | Action::MemberPurged
            | Action::MemberExpirySet
            | Action::MemberReactivated
            | Action::MemberStandingChanged => "guests",
            Action::RoleCreated
            | Action::RoleUpdated
            | Action::RoleDeleted
            | Action::RolesReordered
            | Action::RolePreviewed => "roles",
            Action::ChannelReserved => "channels",
            Action::CalendarWriteAccessChanged => "calendars",
            Action::LicenceInstalled | Action::LicenceRemoved => "licence",
            Action::GroupCreated
            | Action::GroupUpdated
            | Action::GroupDeleted
            | Action::GroupMembersAdded
            | Action::GroupMembersRemoved
            | Action::GroupRolesChanged
            | Action::GroupManagersChanged => "groups",
            Action::RuleCreated | Action::RuleUpdated | Action::RuleDeleted => "access",
        }
    }
}

/// What it happened to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Member(Uuid),
    Role(Uuid),
    Group(Uuid),
    Channel(Uuid),
    /// A file or a folder.
    File(Uuid),
    Calendar(Uuid),
    Space,
    Licence,
}

impl Target {
    fn kind(self) -> &'static str {
        match self {
            Target::Member(_) => "member",
            Target::Role(_) => "role",
            Target::Group(_) => "group",
            Target::Channel(_) => "channel",
            Target::File(_) => "file",
            Target::Calendar(_) => "calendar",
            Target::Space => "space",
            Target::Licence => "licence",
        }
    }

    fn id(self) -> Option<Uuid> {
        match self {
            Target::Member(id)
            | Target::Role(id)
            | Target::Group(id)
            | Target::Channel(id)
            | Target::File(id)
            | Target::Calendar(id) => Some(id),
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

/// Whether the journal of `space_id` already carries the `import.applied` line of `job_id`: an
/// import writes one line per job and space, however many times it saves.
pub async fn import_line_exists(
    db: &impl ConnectionTrait,
    space_id: Uuid,
    job_id: Uuid,
) -> Result<bool, DbErr> {
    Ok(db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 AS one FROM space_audit_log \
             WHERE space_id = $1 AND action = 'import.applied' AND details->>'job_id' = $2",
            [space_id.into(), job_id.to_string().into()],
        ))
        .await?
        .is_some())
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

    #[test]
    fn rule_writes_are_dotted_and_filed_under_access() {
        for (action, name) in [
            (Action::RuleCreated, "rule.created"),
            (Action::RuleUpdated, "rule.updated"),
            (Action::RuleDeleted, "rule.deleted"),
        ] {
            assert_eq!(action.as_str(), name);
            assert_eq!(action.category(), "access");
            assert!(Action::ALL.contains(&action));
        }
    }

    #[test]
    fn import_applied_is_filed_under_members() {
        assert_eq!(Action::ImportApplied.as_str(), "import.applied");
        assert_eq!(Action::ImportApplied.category(), "members");
        assert!(Action::ALL.contains(&Action::ImportApplied));
        assert_eq!(Action::ALL.len(), 31);
    }
}
