//! Who edits a resource's access, and the one check every rule write goes through (permissions
//! lot 4, ruling 4).
//!
//! [`editor_of`] says whether, and as what, someone may edit the access of a channel, a file or
//! folder, or a calendar ([`EditorKind`]); [`ensure_writable`] is the pure decision over that editor
//! and the rule they want to write, so the route, the dialog's `may` block and the tests cannot
//! disagree. The refusals come in a fixed order ([`RuleRefusal`]).

use sea_orm::{ConnectionTrait, DbBackend, DbErr, Statement};
use uuid::Uuid;

use super::catalogue::{Permission, PermissionSet};
use super::check::{effective, space_rights, standing, Resource};
use super::delegation::{rank_of, Rank};
use super::engine::Standing;
use super::groups::Paid;
use super::levels::{level_of, Kind, Level, LevelRead, Target};
use super::system_roles::GUEST_CEILING;
use crate::audit::{record, Action, Target as AuditTarget};
use crate::messaging::error::ApiError;
use crate::state::AppState;

/// What a rule is set on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceRef {
    Channel(Uuid),
    /// A file or a folder.
    File(Uuid),
    Calendar(Uuid),
}

impl ResourceRef {
    pub fn id(self) -> Uuid {
        match self {
            ResourceRef::Channel(id) | ResourceRef::File(id) | ResourceRef::Calendar(id) => id,
        }
    }

    pub fn kind(self) -> Kind {
        match self {
            ResourceRef::Channel(_) => Kind::Channel,
            ResourceRef::File(_) => Kind::File,
            ResourceRef::Calendar(_) => Kind::Calendar,
        }
    }

    /// The permission that edits the access of this family of resources.
    pub fn manage(self) -> Permission {
        match self {
            ResourceRef::Channel(_) => Permission::ChannelManage,
            ResourceRef::File(_) => Permission::FilesManage,
            ResourceRef::Calendar(_) => Permission::CalendarManage,
        }
    }

    /// The column of `permission_overrides` that names this kind of resource.
    pub fn column(self) -> &'static str {
        match self {
            ResourceRef::Channel(_) => "channel_id",
            ResourceRef::File(_) => "file_id",
            ResourceRef::Calendar(_) => "calendar_id",
        }
    }

    /// The permission that opens the resource.
    pub fn view(self) -> Permission {
        match self {
            ResourceRef::Channel(_) => Permission::ChannelView,
            ResourceRef::File(_) => Permission::FilesView,
            ResourceRef::Calendar(_) => Permission::CalendarView,
        }
    }

    pub fn engine(self) -> Resource {
        match self {
            ResourceRef::Channel(id) => Resource::Channel(id),
            ResourceRef::File(id) => Resource::File(id),
            ResourceRef::Calendar(id) => Resource::Calendar(id),
        }
    }
}

/// Why someone may edit a resource's access (ruling 4 and pre-flight P3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorKind {
    /// The space's owner.
    Owner,
    /// Holds the family's manage permission at space level (Administrator by default).
    Space,
    /// The channel's owner or admin.
    ChannelModerator,
    /// The author of a file or folder, in every edition.
    Author,
    /// Holds the manage permission on this resource only: a paid delegation.
    Local,
}

/// Someone allowed to look at a resource's access dialog for editing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Editor {
    pub kind: EditorKind,
    /// What they hold on the resource itself (rule 2).
    pub rights: PermissionSet,
    pub rank: Rank,
    pub paid: Paid,
}

/// The facts [`editor_of`] settles one after the other, so the table is testable without a
/// database.
#[derive(Debug, Clone, Copy, Default)]
struct EditorFacts {
    owner: bool,
    /// Holds the family's manage permission at space level.
    space_manage: bool,
    channel_moderator: bool,
    author: bool,
    /// Holds the manage permission on the resource.
    local_manage: bool,
}

/// The table of ruling 4, strongest reason first.
fn pick_kind(facts: EditorFacts) -> Option<EditorKind> {
    if facts.owner {
        Some(EditorKind::Owner)
    } else if facts.space_manage {
        Some(EditorKind::Space)
    } else if facts.channel_moderator {
        Some(EditorKind::ChannelModerator)
    } else if facts.author {
        Some(EditorKind::Author)
    } else if facts.local_manage {
        Some(EditorKind::Local)
    } else {
        None
    }
}

/// What the resource's own row says about `user_id`: `None` when it is not the space's.
async fn resource_facts(
    db: &impl ConnectionTrait,
    space_id: Uuid,
    user_id: Uuid,
    resource: ResourceRef,
) -> Result<Option<(bool, bool)>, DbErr> {
    // (is a channel owner or admin, is the author)
    let (sql, moderator_column) = match resource {
        ResourceRef::Channel(_) => (
            "SELECT coalesce((SELECT m.role IN ('owner', 'admin') FROM channel_members m \
                               WHERE m.channel_id = c.id AND m.user_id = $3), false) AS flag \
               FROM channels c WHERE c.id = $2 AND c.space_id = $1",
            true,
        ),
        ResourceRef::File(_) => (
            "SELECT coalesce(f.owner_id = $3, false) AS flag \
               FROM files f WHERE f.id = $2 AND f.space_id = $1",
            false,
        ),
        ResourceRef::Calendar(_) => (
            "SELECT false AS flag FROM calendars c WHERE c.id = $2 AND c.space_id = $1",
            false,
        ),
    };
    let Some(row) = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            [space_id.into(), resource.id().into(), user_id.into()],
        ))
        .await?
    else {
        return Ok(None);
    };
    let flag: bool = row.try_get("", "flag")?;
    Ok(Some((flag && moderator_column, flag && !moderator_column)))
}

/// Whether `user_id` may edit `resource`'s access, and as what. `None` for someone who may not
/// (or a resource that is not the space's). A [`EditorKind::Local`] editor is answered whatever the
/// licence, with `paid` set: [`ensure_writable`] refuses them without one.
pub async fn editor_of(
    state: &AppState,
    space_id: Uuid,
    user_id: Uuid,
    resource: ResourceRef,
) -> Result<Option<Editor>, ApiError> {
    let Some(rank) = rank_of(&state.db, space_id, user_id).await? else {
        return Ok(None);
    };
    let Some((moderator, author)) = resource_facts(&state.db, space_id, user_id, resource).await?
    else {
        return Ok(None);
    };
    // A guest's channel role and authorship are no standing: only a rule can make them an editor,
    // and the guest ceiling keeps the manage permission from them.
    let guest = standing(&state.db, space_id, user_id).await? == Some(Standing::Guest);
    let on_resource = effective(&state.db, space_id, user_id, resource.engine()).await?;
    let at_space = space_rights(&state.db, space_id, user_id).await?;
    let facts = EditorFacts {
        owner: rank == Rank::Owner,
        space_manage: at_space.contains(resource.manage()),
        channel_moderator: moderator && !guest,
        author: author && !guest,
        local_manage: on_resource.contains(resource.manage()),
    };
    let Some(kind) = pick_kind(facts) else {
        return Ok(None);
    };
    // Rule 2 reads what the editor holds. An Owner or Space editor holds the family's permissions
    // at space level: lowering "everyone" on a resource must not take from them the means to raise
    // it again. The others hold what the resource leaves them.
    let rights = if matches!(kind, EditorKind::Owner | EditorKind::Space) {
        at_space.intersect(PermissionSet::of_family(resource.manage().family()))
    } else {
        on_resource
    };
    let paid = Paid::from(&state.edition.entitlement(&state.db, space_id).await?);
    Ok(Some(Editor {
        kind,
        rights,
        rank,
        paid,
    }))
}

/// Who a rule is aimed at, with what the checks need to know about them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Aim {
    /// `@members`, or `@guests` when `guests`.
    Everyone { guests: bool },
    /// A role at `position` (Administrator included when `system`); `editor_holds` when the editor
    /// holds it themselves (directly or through a group).
    Role {
        position: i32,
        system: bool,
        editor_holds: bool,
    },
    /// A group: whether the editor is in it, and the highest position among the roles it carries.
    Group {
        editor_in: bool,
        top_position: Option<i32>,
    },
    /// A person.
    User {
        is_editor: bool,
        rank: Rank,
        guest: bool,
    },
    /// The readers of a channel (files only); `editor_reads` when the editor can view that channel,
    /// so they are one of the readers the rule is about.
    Audience { editor_reads: bool },
}

/// The target of a rule as [`ensure_writable`] reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TargetRef {
    /// False when the role, group, person or channel is not the space's.
    pub in_space: bool,
    pub aim: Aim,
}

impl TargetRef {
    fn level_target(self) -> Target {
        match self.aim {
            Aim::Everyone { .. } => Target::Everyone,
            Aim::Role { system, .. } => Target::Role { system },
            Aim::Group { .. } => Target::Group,
            Aim::User { .. } => Target::User,
            Aim::Audience { .. } => Target::Audience,
        }
    }
}

/// A rule already stored on the resource for the target, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Existing {
    pub allow: PermissionSet,
    pub deny: PermissionSet,
}

/// Why a rule may not be written, in the order the checks run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleRefusal {
    /// `402 licence_required`.
    LicenceRequired,
    /// `409 licence_frozen`.
    LicenceFrozen,
    /// `403` with this code: `cannot_grant`, `target_above_you`.
    Forbidden(&'static str),
    /// `400` with this code: `guest_ceiling`, `not_in_space`, `audience_files_only`.
    BadRequest(&'static str),
}

impl RuleRefusal {
    /// The code a client reads (`licence_required` for the two licence refusals' family).
    pub fn code(self) -> &'static str {
        match self {
            RuleRefusal::LicenceRequired => "licence_required",
            RuleRefusal::LicenceFrozen => "licence_frozen",
            RuleRefusal::Forbidden(code) | RuleRefusal::BadRequest(code) => code,
        }
    }

    /// The HTTP error, with where to buy a licence for the one that needs it.
    pub fn into_api(self, pricing_url: &str) -> ApiError {
        match self {
            RuleRefusal::LicenceRequired => ApiError::LicenceRequired {
                pricing_url: pricing_url.to_owned(),
            },
            RuleRefusal::LicenceFrozen => ApiError::LicenceFrozen,
            RuleRefusal::Forbidden(code) => ApiError::ForbiddenBecause(code),
            RuleRefusal::BadRequest(code) => ApiError::BadRequestCode {
                code,
                message: match code {
                    "guest_ceiling" => "A guest cannot hold this much on a resource.",
                    "not_in_space" => "This target does not belong to the space.",
                    "audience_files_only" => "The readers of a channel can only be named on files.",
                    _ => "This rule cannot be written.",
                },
            },
        }
    }
}

/// Whether `editor` may write the rule `allow`/`deny` for `target` on `resource`, where `existing`
/// is what is stored now. Checks, in this order: a local editor needs the licence; rule 2 (they
/// hold what an allow adds, on this resource); rule 3 (a deny, or a change of a stored rule, aimed
/// at them, a group of theirs or a role or person at or above their rank, "everyone" excepted, unless
/// Owner or Space);
/// the guest ceiling; the target is the space's; audiences are files only; the fine rules are paid.
pub fn ensure_writable(
    editor: &Editor,
    resource: &ResourceRef,
    target: &TargetRef,
    allow: PermissionSet,
    deny: PermissionSet,
    existing: Option<&Existing>,
) -> Result<(), RuleRefusal> {
    if editor.kind == EditorKind::Local {
        match editor.paid {
            Paid::Enterprise => {}
            Paid::Frozen => return Err(RuleRefusal::LicenceFrozen),
            Paid::Community => return Err(RuleRefusal::LicenceRequired),
        }
    }
    // Rule 2: what an allow adds, the editor holds on this resource.
    if !allow.minus(editor.rights).is_empty() {
        return Err(RuleRefusal::Forbidden("cannot_grant"));
    }
    // Rules 3 and the reservation, for the editors who are not Owner or Space.
    let strong = matches!(editor.kind, EditorKind::Owner | EditorKind::Space);
    if !strong {
        if aimed_at_or_above(editor, target) {
            return Err(RuleRefusal::Forbidden("target_above_you"));
        }
        if matches!(target.aim, Aim::Everyone { .. }) {
            let kind = resource.kind();
            let none =
                |a, d| level_of(kind, Target::Everyone, a, d) == LevelRead::Level(Level::None);
            if deny.contains(resource.view())
                || none(allow, deny)
                || existing
                    .is_some_and(|e| none(e.allow, e.deny) || e.deny.contains(resource.view()))
            {
                return Err(RuleRefusal::Forbidden("reservation_admins_only"));
            }
        }
    }
    let guest = matches!(
        target.aim,
        Aim::Everyone { guests: true } | Aim::User { guest: true, .. }
    );
    if guest && !allow.intersect(GUEST_CEILING).is_empty() {
        return Err(RuleRefusal::BadRequest("guest_ceiling"));
    }
    if !target.in_space {
        return Err(RuleRefusal::BadRequest("not_in_space"));
    }
    if matches!(target.aim, Aim::Audience { .. }) && !matches!(resource, ResourceRef::File(_)) {
        return Err(RuleRefusal::BadRequest("audience_files_only"));
    }
    // Fine rules: a custom role as a target, or sets that are no preset level.
    let custom_role = matches!(target.aim, Aim::Role { system: false, .. });
    let class = target.level_target();
    let custom = |allow, deny| level_of(resource.kind(), class, allow, deny) == LevelRead::Custom;
    // Writing nothing is removing the rule: that is as free as the rule it removes.
    let fine = if allow.is_empty() && deny.is_empty() {
        existing.is_some_and(|e| custom(e.allow, e.deny))
    } else {
        custom(allow, deny)
    };
    if custom_role || fine {
        match editor.paid {
            Paid::Enterprise => {}
            Paid::Frozen => return Err(RuleRefusal::LicenceFrozen),
            Paid::Community => return Err(RuleRefusal::LicenceRequired),
        }
    }
    Ok(())
}

/// Whether `position` sits strictly above the rank (an owner is never below a position).
fn position_above(rank: Rank, position: i32) -> bool {
    match rank {
        Rank::Owner => false,
        Rank::Position(mine) => position > mine,
    }
}

/// Whether `other` stands strictly above `rank` (an owner above everyone who is not one).
fn rank_above(rank: Rank, other: Rank) -> bool {
    match other {
        Rank::Owner => rank != Rank::Owner,
        Rank::Position(theirs) => position_above(rank, theirs),
    }
}

/// Rule 3 for the editors below Owner and Space: the target is the editor, a group they are in, a
/// role they hold, or a person, role or group (by the roles it carries) strictly above their rank.
/// Equal-rank others are allowed. "Everyone" names no one above; an audience is the editor's own
/// when they read its channel.
fn aimed_at_or_above(editor: &Editor, target: &TargetRef) -> bool {
    match target.aim {
        Aim::Everyone { .. } => false,
        Aim::Audience { editor_reads } => editor_reads,
        Aim::Role {
            position,
            editor_holds,
            ..
        } => editor_holds || position_above(editor.rank, position),
        Aim::Group {
            editor_in,
            top_position,
        } => editor_in || top_position.is_some_and(|p| position_above(editor.rank, p)),
        Aim::User {
            is_editor, rank, ..
        } => is_editor || rank_above(editor.rank, rank),
    }
}

/// A place that names a group or a role in a rule.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, utoipa::ToSchema)]
pub struct UsedIn {
    /// `channel`, `file` or `calendar`.
    pub kind: &'static str,
    pub id: Uuid,
    pub name: String,
}

/// Whom a rule is aimed at, for [`uses_of`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Named {
    Role(Uuid),
    Group(Uuid),
    User(Uuid),
}

/// Every channel, file and calendar of the space with a rule aimed at `target`, by name.
pub async fn uses_of(
    db: &impl ConnectionTrait,
    space_id: Uuid,
    target: Named,
) -> Result<Vec<UsedIn>, DbErr> {
    let (column, id) = match target {
        Named::Role(id) => ("role_id", id),
        Named::Group(id) => ("group_id", id),
        Named::User(id) => ("user_id", id),
    };
    let sql = format!(
        "SELECT 'channel' AS kind, r.id, r.name::text AS name FROM permission_overrides o \
           JOIN channels r ON r.id = o.channel_id WHERE o.space_id = $1 AND o.{column} = $2 \
         UNION ALL \
         SELECT 'file', r.id, r.name::text FROM permission_overrides o \
           JOIN files r ON r.id = o.file_id WHERE o.space_id = $1 AND o.{column} = $2 \
         UNION ALL \
         SELECT 'calendar', r.id, r.name::text FROM permission_overrides o \
           JOIN calendars r ON r.id = o.calendar_id WHERE o.space_id = $1 AND o.{column} = $2 \
         ORDER BY name, id"
    );
    let mut used = Vec::new();
    for row in db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            [space_id.into(), id.into()],
        ))
        .await?
    {
        let kind: String = row.try_get("", "kind")?;
        used.push(UsedIn {
            kind: match kind.as_str() {
                "channel" => "channel",
                "file" => "file",
                _ => "calendar",
            },
            id: row.try_get("", "id")?,
            name: row.try_get("", "name")?,
        });
    }
    Ok(used)
}

/// Whom a stored rule is aimed at: which column names them, and how the levels read them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleSubject {
    /// `@members` or `@guests`: the base role of a standing.
    Everyone {
        role: Uuid,
    },
    /// A role: the Administrator (`system`) or a custom one.
    Role {
        id: Uuid,
        system: bool,
    },
    User(Uuid),
    Group(Uuid),
    /// The readers of a channel (files only).
    Audience(Uuid),
}

impl RuleSubject {
    pub fn column(self) -> &'static str {
        match self {
            RuleSubject::Everyone { .. } | RuleSubject::Role { .. } => "role_id",
            RuleSubject::User(_) => "user_id",
            RuleSubject::Group(_) => "group_id",
            RuleSubject::Audience(_) => "audience_channel_id",
        }
    }

    pub fn id(self) -> Uuid {
        match self {
            RuleSubject::Everyone { role: id }
            | RuleSubject::Role { id, .. }
            | RuleSubject::User(id)
            | RuleSubject::Group(id)
            | RuleSubject::Audience(id) => id,
        }
    }

    /// The word the log and the wire use for this kind of target.
    pub fn kind_name(self) -> &'static str {
        match self {
            RuleSubject::Everyone { .. } => "everyone",
            RuleSubject::Role { .. } => "role",
            RuleSubject::User(_) => "user",
            RuleSubject::Group(_) => "group",
            RuleSubject::Audience(_) => "audience",
        }
    }

    /// How [`level_of`] and [`super::levels::rule_sets`] treat this target.
    pub fn class(self) -> Target {
        match self {
            RuleSubject::Everyone { .. } => Target::Everyone,
            RuleSubject::Role { system, .. } => Target::Role { system },
            RuleSubject::User(_) => Target::User,
            RuleSubject::Group(_) => Target::Group,
            RuleSubject::Audience(_) => Target::Audience,
        }
    }
}

/// A rule as it is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuleRow {
    pub id: Uuid,
    pub allow: PermissionSet,
    pub deny: PermissionSet,
}

/// What the log says a write changed, as the dialog reads it: a level name, a pair of permission
/// lists for a custom rule, or null for no rule. The caller words it, because for the system roles
/// the level is not only what the row stores (the legacy bit lives elsewhere).
#[derive(Debug, Clone, PartialEq)]
pub struct Shown {
    pub before: serde_json::Value,
    pub after: serde_json::Value,
}

/// A stored rule as the log words it: its level name, or its permissions when it is custom.
pub fn describe(
    kind: Kind,
    class: Target,
    allow: PermissionSet,
    deny: PermissionSet,
) -> serde_json::Value {
    match level_of(kind, class, allow, deny) {
        LevelRead::Level(level) => serde_json::Value::from(level_name(level)),
        LevelRead::NoRule => serde_json::Value::Null,
        LevelRead::Custom => {
            serde_json::json!({ "allow": allow.to_names(), "deny": deny.to_names() })
        }
    }
}

/// The wire name of a level.
pub fn level_name(level: Level) -> &'static str {
    match level {
        Level::None => "none",
        Level::Read => "read",
        Level::Contribute => "contribute",
        Level::Manage => "manage",
    }
}

/// Lock the resource's own row, so that every write to its rules is one at a time and decides on
/// what it read. `404` when it is not the space's (or has just been deleted).
pub async fn lock_resource(
    txn: &impl ConnectionTrait,
    space_id: Uuid,
    resource: ResourceRef,
) -> Result<(), ApiError> {
    let table = match resource {
        ResourceRef::Channel(_) => "channels",
        ResourceRef::File(_) => "files",
        ResourceRef::Calendar(_) => "calendars",
    };
    let locked = txn
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!("SELECT id FROM {table} WHERE id = $1 AND space_id = $2 FOR UPDATE"),
            [resource.id().into(), space_id.into()],
        ))
        .await?;
    if locked.is_none() {
        return Err(ApiError::NotFound);
    }
    Ok(())
}

fn row_of(row: &sea_orm::QueryResult) -> Result<RuleRow, DbErr> {
    let allow: Vec<String> = row.try_get("", "allow")?;
    let deny: Vec<String> = row.try_get("", "deny")?;
    Ok(RuleRow {
        id: row.try_get("", "id")?,
        allow: PermissionSet::from_names(&allow),
        deny: PermissionSet::from_names(&deny),
    })
}

/// The rule stored on `resource` for `subject`, if any.
pub async fn current_rule(
    txn: &impl ConnectionTrait,
    space_id: Uuid,
    resource: ResourceRef,
    subject: RuleSubject,
) -> Result<Option<RuleRow>, DbErr> {
    let row = txn
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!(
                "SELECT id, allow, deny FROM permission_overrides \
                  WHERE space_id = $1 AND {} = $2 AND {} = $3",
                resource.column(),
                subject.column()
            ),
            [space_id.into(), resource.id().into(), subject.id().into()],
        ))
        .await?;
    row.as_ref().map(row_of).transpose()
}

/// Write the rule `allow`/`deny` for `subject` on `resource`: the resource's row is locked, the
/// rule is created or replaced on its unique index (whoever made it first stays its `created_by`),
/// and the entry goes into the log in the same transaction. The caller has decided
/// ([`ensure_writable`]) and tells the space after the commit
/// ([`super::changed::announce`]).
#[allow(clippy::too_many_arguments)]
pub async fn write_rule(
    txn: &impl ConnectionTrait,
    space_id: Uuid,
    actor: Uuid,
    resource: ResourceRef,
    subject: RuleSubject,
    allow: PermissionSet,
    deny: PermissionSet,
    shown: Shown,
) -> Result<RuleRow, ApiError> {
    lock_resource(txn, space_id, resource).await?;
    let (resource_column, subject_column) = (resource.column(), subject.column());
    let row = txn
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!(
                "INSERT INTO permission_overrides (space_id, {resource_column}, {subject_column}, \
                                                   allow, deny, created_by) \
                 VALUES ($1, $2, $3, $4, $5, $6) \
                 ON CONFLICT ({resource_column}, {subject_column}) \
                     WHERE {resource_column} IS NOT NULL AND {subject_column} IS NOT NULL \
                 DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny, updated_at = now() \
                 RETURNING id, allow, deny"
            ),
            [
                space_id.into(),
                resource.id().into(),
                subject.id().into(),
                allow.to_names().into(),
                deny.to_names().into(),
                actor.into(),
            ],
        ))
        .await?
        .ok_or(ApiError::Internal)?;
    let written = row_of(&row)?;
    let action = if shown.before.is_null() {
        Action::RuleCreated
    } else {
        Action::RuleUpdated
    };
    log_rule(txn, space_id, actor, action, resource, subject, shown).await?;
    Ok(written)
}

/// Remove the rule `rule_id` of `resource` (`404` when it is not one of its rules), and log it.
pub async fn delete_rule(
    txn: &impl ConnectionTrait,
    space_id: Uuid,
    actor: Uuid,
    resource: ResourceRef,
    subject: RuleSubject,
    rule_id: Uuid,
    shown: Shown,
) -> Result<(), ApiError> {
    lock_resource(txn, space_id, resource).await?;
    let gone = txn
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!(
                "DELETE FROM permission_overrides WHERE id = $1 AND space_id = $2 AND {} = $3",
                resource.column()
            ),
            [rule_id.into(), space_id.into(), resource.id().into()],
        ))
        .await?
        .rows_affected();
    if gone == 0 {
        return Err(ApiError::NotFound);
    }
    log_rule(
        txn,
        space_id,
        actor,
        Action::RuleDeleted,
        resource,
        subject,
        shown,
    )
    .await?;
    Ok(())
}

/// Put a rule's entry in the log without writing the rule (a level the legacy settings carry).
pub async fn log_rule(
    txn: &impl ConnectionTrait,
    space_id: Uuid,
    actor: Uuid,
    action: Action,
    resource: ResourceRef,
    subject: RuleSubject,
    shown: Shown,
) -> Result<(), DbErr> {
    let target = match resource {
        ResourceRef::Channel(id) => AuditTarget::Channel(id),
        ResourceRef::File(id) => AuditTarget::File(id),
        ResourceRef::Calendar(id) => AuditTarget::Calendar(id),
    };
    record(
        txn,
        space_id,
        Some(actor),
        action,
        target,
        serde_json::json!({
            "target_kind": subject.kind_name(),
            "target_id": subject.id(),
            "before": shown.before,
            "after": shown.after,
        }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use Permission as P;

    fn set(permissions: &[P]) -> PermissionSet {
        PermissionSet::of(permissions)
    }

    fn editor(kind: EditorKind, rights: PermissionSet) -> Editor {
        Editor {
            kind,
            rights,
            rank: Rank::Position(0),
            paid: Paid::Community,
        }
    }

    fn admin_like() -> Editor {
        Editor {
            kind: EditorKind::Space,
            rights: PermissionSet::ALL,
            rank: Rank::Position(100),
            paid: Paid::Community,
        }
    }

    fn at(aim: Aim) -> TargetRef {
        TargetRef {
            in_space: true,
            aim,
        }
    }

    const CHANNEL: ResourceRef = ResourceRef::Channel(Uuid::nil());
    const FILE: ResourceRef = ResourceRef::File(Uuid::nil());
    const CALENDAR: ResourceRef = ResourceRef::Calendar(Uuid::nil());

    fn read(r: ResourceRef) -> PermissionSet {
        super::super::levels::level_sets(r.kind(), super::super::levels::Level::Read)
    }

    fn group() -> TargetRef {
        at(Aim::Group {
            editor_in: false,
            top_position: None,
        })
    }

    fn write(
        editor: &Editor,
        resource: ResourceRef,
        target: TargetRef,
        allow: PermissionSet,
        deny: PermissionSet,
        existing: Option<Existing>,
    ) -> Result<(), RuleRefusal> {
        ensure_writable(editor, &resource, &target, allow, deny, existing.as_ref())
    }

    #[test]
    fn editor_table_matches_ruling_4() {
        let none = EditorFacts::default();
        assert_eq!(pick_kind(none), None);
        let only = |f: fn(&mut EditorFacts)| {
            let mut facts = none;
            f(&mut facts);
            pick_kind(facts)
        };
        assert_eq!(only(|f| f.owner = true), Some(EditorKind::Owner));
        assert_eq!(only(|f| f.space_manage = true), Some(EditorKind::Space));
        assert_eq!(
            only(|f| f.channel_moderator = true),
            Some(EditorKind::ChannelModerator)
        );
        assert_eq!(only(|f| f.author = true), Some(EditorKind::Author));
        assert_eq!(only(|f| f.local_manage = true), Some(EditorKind::Local));
        // The strongest reason wins, in this order.
        let all = EditorFacts {
            owner: true,
            space_manage: true,
            channel_moderator: true,
            author: true,
            local_manage: true,
        };
        assert_eq!(pick_kind(all), Some(EditorKind::Owner));
        assert_eq!(
            pick_kind(EditorFacts {
                owner: false,
                ..all
            }),
            Some(EditorKind::Space)
        );
        assert_eq!(
            pick_kind(EditorFacts {
                owner: false,
                space_manage: false,
                ..all
            }),
            Some(EditorKind::ChannelModerator)
        );
        assert_eq!(
            pick_kind(EditorFacts {
                owner: false,
                space_manage: false,
                channel_moderator: false,
                ..all
            }),
            Some(EditorKind::Author)
        );
        assert_eq!(
            pick_kind(EditorFacts {
                local_manage: true,
                ..none
            }),
            Some(EditorKind::Local)
        );
    }

    #[test]
    fn a_free_level_for_everyone_passes_for_a_space_editor() {
        let space = admin_like();
        let (allow, deny) = super::super::levels::rule_sets(
            Kind::Channel,
            Target::Everyone,
            super::super::levels::Level::Contribute,
        )
        .unwrap();
        assert_eq!(
            write(
                &space,
                CHANNEL,
                at(Aim::Everyone { guests: false }),
                allow,
                deny,
                None
            ),
            Ok(())
        );
        // A system role and "Aucun accès" for everyone are free too.
        assert_eq!(
            write(
                &space,
                FILE,
                at(Aim::Role {
                    position: 100,
                    system: true,
                    editor_holds: false
                }),
                read(FILE),
                PermissionSet::EMPTY,
                None
            ),
            Ok(())
        );
        assert_eq!(
            write(
                &space,
                FILE,
                at(Aim::Everyone { guests: false }),
                PermissionSet::EMPTY,
                set(&[P::FilesView]),
                None
            ),
            Ok(())
        );
    }

    #[test]
    fn a_local_editor_needs_the_licence() {
        let mut local = editor(EditorKind::Local, PermissionSet::ALL);
        let user = at(Aim::User {
            is_editor: false,
            rank: Rank::Position(-1),
            guest: false,
        });
        local.paid = Paid::Community;
        assert_eq!(
            write(&local, FILE, user, read(FILE), PermissionSet::EMPTY, None),
            Err(RuleRefusal::LicenceRequired)
        );
        local.paid = Paid::Frozen;
        assert_eq!(
            write(&local, FILE, user, read(FILE), PermissionSet::EMPTY, None),
            Err(RuleRefusal::LicenceFrozen)
        );
        local.paid = Paid::Enterprise;
        assert_eq!(
            write(&local, FILE, user, read(FILE), PermissionSet::EMPTY, None),
            Ok(())
        );
        // The licence is the first thing asked: it hides every later refusal.
        local.paid = Paid::Community;
        assert_eq!(
            write(
                &local,
                FILE,
                at(Aim::Audience {
                    editor_reads: false
                }),
                PermissionSet::ALL,
                PermissionSet::EMPTY,
                None
            ),
            Err(RuleRefusal::LicenceRequired)
        );
    }

    #[test]
    fn you_cannot_grant_what_you_do_not_hold_on_the_resource() {
        let author = editor(EditorKind::Author, set(&[P::FilesView, P::FilesManage]));
        // Holding everything the allow adds: fine.
        assert_eq!(
            write(
                &author,
                FILE,
                group(),
                set(&[P::FilesView]),
                PermissionSet::EMPTY,
                None
            ),
            Ok(())
        );
        // One permission not held (files.edit): refused, whatever the target.
        let refused = write(
            &author,
            FILE,
            at(Aim::Everyone { guests: false }),
            set(&[P::FilesView, P::FilesEdit]),
            PermissionSet::EMPTY,
            None,
        );
        assert_eq!(refused, Err(RuleRefusal::Forbidden("cannot_grant")));
        assert_eq!(refused.unwrap_err().code(), "cannot_grant");
        // A deny is not a grant: rule 2 looks at the allow only (Lire for everyone denies the rest).
        let (allow, deny) = super::super::levels::rule_sets(
            Kind::File,
            Target::Everyone,
            super::super::levels::Level::Read,
        )
        .unwrap();
        assert!(!deny.is_empty());
        assert_eq!(
            write(
                &author,
                FILE,
                at(Aim::Everyone { guests: false }),
                allow,
                deny,
                None
            ),
            Ok(())
        );
        // The check runs before the later ones: the audience target is not reached.
        assert_eq!(
            write(
                &author,
                FILE,
                at(Aim::Audience {
                    editor_reads: false
                }),
                set(&[P::FilesEdit]),
                PermissionSet::EMPTY,
                None
            ),
            Err(RuleRefusal::Forbidden("cannot_grant"))
        );
    }

    fn user(is_editor: bool, rank: Rank) -> TargetRef {
        at(Aim::User {
            is_editor,
            rank,
            guest: false,
        })
    }

    fn role(position: i32, editor_holds: bool) -> TargetRef {
        at(Aim::Role {
            position,
            system: false,
            editor_holds,
        })
    }

    fn licensed(kind: EditorKind) -> Editor {
        Editor {
            paid: Paid::Enterprise,
            rank: Rank::Position(10),
            ..editor(kind, PermissionSet::ALL)
        }
    }

    #[test]
    fn nobody_edits_a_rule_aimed_at_themselves_or_strictly_above() {
        let local = licensed(EditorKind::Local);
        let deny = set(&[P::FilesView]);
        let nothing = PermissionSet::EMPTY;
        let stored = Some(Existing {
            allow: read(FILE),
            deny: nothing,
        });
        let refused = [
            // The editor, a group of theirs, a role they hold.
            user(true, Rank::Position(10)),
            at(Aim::Group {
                editor_in: true,
                top_position: None,
            }),
            role(3, true),
            // Strictly above: a person, an owner, a group by its top role, a role.
            user(false, Rank::Position(11)),
            user(false, Rank::Owner),
            at(Aim::Group {
                editor_in: false,
                top_position: Some(11),
            }),
            role(11, false),
        ];
        for target in refused {
            // Creating, changing (allow only) and denying are all refused.
            for (allow, deny, existing) in [
                (read(FILE), nothing, None),
                (read(FILE), nothing, stored),
                (nothing, deny, None),
            ] {
                assert_eq!(
                    write(&local, FILE, target, allow, deny, existing),
                    Err(RuleRefusal::Forbidden("target_above_you")),
                    "{target:?}"
                );
            }
        }
        // Deleting goes through the same check, with what is stored.
        assert_eq!(
            write(
                &local,
                FILE,
                user(true, Rank::Position(10)),
                nothing,
                nothing,
                stored
            ),
            Err(RuleRefusal::Forbidden("target_above_you"))
        );
        // Equal rank is allowed: a person, a group by its top role, a role not held.
        for target in [
            user(false, Rank::Position(10)),
            user(false, Rank::Position(9)),
            at(Aim::Group {
                editor_in: false,
                top_position: Some(10),
            }),
            at(Aim::Group {
                editor_in: false,
                top_position: None,
            }),
            role(10, false),
            role(2, false),
        ] {
            assert_eq!(
                write(&local, FILE, target, read(FILE), nothing, stored),
                Ok(()),
                "{target:?}"
            );
        }
        // An owner-rank person is not above an owner-rank editor.
        let owner_rank = Editor {
            rank: Rank::Owner,
            ..local
        };
        assert_eq!(
            write(
                &owner_rank,
                FILE,
                user(false, Rank::Owner),
                read(FILE),
                nothing,
                None
            ),
            Ok(())
        );
        // Moderators and authors are held by it too.
        for kind in [EditorKind::ChannelModerator, EditorKind::Author] {
            assert_eq!(
                write(
                    &licensed(kind),
                    FILE,
                    user(true, Rank::Position(10)),
                    read(FILE),
                    nothing,
                    None
                ),
                Err(RuleRefusal::Forbidden("target_above_you")),
                "{kind:?}"
            );
        }
        // Owner and Space editors are exempt.
        for kind in [EditorKind::Owner, EditorKind::Space] {
            let boss = licensed(kind);
            for target in refused {
                assert_eq!(
                    write(&boss, FILE, target, read(FILE), nothing, stored),
                    Ok(()),
                    "{kind:?} {target:?}"
                );
            }
        }
    }

    #[test]
    fn nobody_lifts_a_rule_aimed_at_the_readers_they_are_among() {
        let deny = set(&[P::FilesView]);
        let nothing = PermissionSet::EMPTY;
        let stored = Some(Existing {
            allow: nothing,
            deny,
        });
        let mine = at(Aim::Audience { editor_reads: true });
        let others = at(Aim::Audience {
            editor_reads: false,
        });
        for kind in [
            EditorKind::ChannelModerator,
            EditorKind::Author,
            EditorKind::Local,
        ] {
            let who = licensed(kind);
            // Create, change and delete are all refused when they read that channel.
            for (allow, deny, existing) in [
                (read(FILE), nothing, None),
                (read(FILE), nothing, stored),
                (nothing, nothing, stored),
                (nothing, deny, None),
            ] {
                assert_eq!(
                    write(&who, FILE, mine, allow, deny, existing),
                    Err(RuleRefusal::Forbidden("target_above_you")),
                    "{kind:?}"
                );
            }
            assert_eq!(
                write(&who, FILE, others, read(FILE), nothing, stored),
                Ok(())
            );
        }
        for kind in [EditorKind::Owner, EditorKind::Space] {
            assert_eq!(
                write(&licensed(kind), FILE, mine, nothing, nothing, stored),
                Ok(())
            );
        }
    }

    #[test]
    fn an_existing_view_deny_for_everyone_is_the_administrators_whatever_its_level() {
        // A deny of the view bit that reads Custom (it carries other bits), only an admin wrote it.
        let stored = Some(Existing {
            allow: set(&[P::FilesEdit]),
            deny: set(&[P::FilesView, P::FilesManage]),
        });
        let everyone = at(Aim::Everyone { guests: false });
        let lire = super::super::levels::rule_sets(
            Kind::File,
            Target::Everyone,
            super::super::levels::Level::Read,
        )
        .unwrap();
        for kind in [
            EditorKind::ChannelModerator,
            EditorKind::Author,
            EditorKind::Local,
        ] {
            let who = licensed(kind);
            let refused = Err(RuleRefusal::Forbidden("reservation_admins_only"));
            assert_eq!(write(&who, FILE, everyone, lire.0, lire.1, stored), refused);
            assert_eq!(
                write(
                    &who,
                    FILE,
                    everyone,
                    PermissionSet::EMPTY,
                    PermissionSet::EMPTY,
                    stored
                ),
                refused
            );
        }
        assert_eq!(
            write(
                &licensed(EditorKind::Space),
                FILE,
                everyone,
                lire.0,
                lire.1,
                stored
            ),
            Ok(())
        );
    }

    #[test]
    fn the_reservation_stays_with_owner_and_space_editors() {
        let none = (PermissionSet::EMPTY, set(&[P::FilesView]));
        let lire = super::super::levels::rule_sets(
            Kind::File,
            Target::Everyone,
            super::super::levels::Level::Read,
        )
        .unwrap();
        let none_stored = Some(Existing {
            allow: none.0,
            deny: none.1,
        });
        let lire_stored = Some(Existing {
            allow: lire.0,
            deny: lire.1,
        });
        for guests in [false, true] {
            let everyone = at(Aim::Everyone { guests });
            for kind in [
                EditorKind::ChannelModerator,
                EditorKind::Author,
                EditorKind::Local,
            ] {
                let who = licensed(kind);
                let refused = Err(RuleRefusal::Forbidden("reservation_admins_only"));
                // Set it, change it away, remove it.
                assert_eq!(write(&who, FILE, everyone, none.0, none.1, None), refused);
                assert_eq!(
                    write(&who, FILE, everyone, lire.0, lire.1, none_stored),
                    refused
                );
                assert_eq!(
                    write(
                        &who,
                        FILE,
                        everyone,
                        PermissionSet::EMPTY,
                        PermissionSet::EMPTY,
                        none_stored
                    ),
                    refused
                );
                // A deny of the view bit with an allow is still a reservation.
                assert_eq!(
                    write(
                        &who,
                        FILE,
                        everyone,
                        set(&[P::FilesEdit]),
                        set(&[P::FilesView]),
                        None
                    ),
                    refused
                );
                // Lire and up is theirs to set, change and remove.
                assert_eq!(write(&who, FILE, everyone, lire.0, lire.1, None), Ok(()));
                assert_eq!(
                    write(&who, FILE, everyone, lire.0, lire.1, lire_stored),
                    Ok(())
                );
                assert_eq!(
                    write(
                        &who,
                        FILE,
                        everyone,
                        PermissionSet::EMPTY,
                        PermissionSet::EMPTY,
                        lire_stored
                    ),
                    Ok(())
                );
            }
            for kind in [EditorKind::Owner, EditorKind::Space] {
                let boss = licensed(kind);
                assert_eq!(write(&boss, FILE, everyone, none.0, none.1, None), Ok(()));
                assert_eq!(
                    write(&boss, FILE, everyone, lire.0, lire.1, none_stored),
                    Ok(())
                );
            }
        }
        // The view bit of each family.
        for (resource, view) in [(CHANNEL, P::ChannelView), (CALENDAR, P::CalendarView)] {
            assert_eq!(
                write(
                    &licensed(EditorKind::ChannelModerator),
                    resource,
                    at(Aim::Everyone { guests: false }),
                    PermissionSet::EMPTY,
                    set(&[view]),
                    None
                ),
                Err(RuleRefusal::Forbidden("reservation_admins_only"))
            );
        }
    }

    #[test]
    fn a_guest_never_gets_more_than_the_ceiling() {
        let space = admin_like();
        let guests = at(Aim::Everyone { guests: true });
        let a_guest = at(Aim::User {
            is_editor: false,
            rank: Rank::Position(-1),
            guest: true,
        });
        for target in [guests, a_guest] {
            for (resource, manage) in [
                (CHANNEL, P::ChannelManage),
                (FILE, P::FilesManage),
                (CALENDAR, P::CalendarManage),
            ] {
                assert_eq!(
                    write(
                        &space,
                        resource,
                        target,
                        read(resource).union(set(&[manage])),
                        PermissionSet::EMPTY,
                        None
                    ),
                    Err(RuleRefusal::BadRequest("guest_ceiling")),
                    "{resource:?} {target:?}"
                );
            }
            // Anything of the ceiling, not only manage.
            assert_eq!(
                write(
                    &space,
                    FILE,
                    target,
                    set(&[P::FilesPublicLink]),
                    PermissionSet::EMPTY,
                    None
                ),
                Err(RuleRefusal::BadRequest("guest_ceiling"))
            );
        }
        // Read is within the ceiling.
        assert_eq!(
            write(
                &space,
                CHANNEL,
                a_guest,
                read(CHANNEL),
                PermissionSet::EMPTY,
                None
            ),
            Ok(())
        );
        // A group holding guests is clamped by the engine, not refused here.
        assert_eq!(
            write(
                &space,
                FILE,
                group(),
                super::super::levels::level_sets(Kind::File, super::super::levels::Level::Manage),
                PermissionSet::EMPTY,
                None
            ),
            Ok(())
        );
    }

    #[test]
    fn a_target_outside_the_space_is_refused() {
        let space = admin_like();
        for aim in [
            Aim::Role {
                position: 5,
                system: false,
                editor_holds: false,
            },
            Aim::Group {
                editor_in: false,
                top_position: None,
            },
            Aim::User {
                is_editor: false,
                rank: Rank::Position(0),
                guest: false,
            },
            Aim::Audience {
                editor_reads: false,
            },
        ] {
            let target = TargetRef {
                in_space: false,
                aim,
            };
            assert_eq!(
                write(&space, FILE, target, read(FILE), PermissionSet::EMPTY, None),
                Err(RuleRefusal::BadRequest("not_in_space")),
                "{aim:?}"
            );
        }
    }

    #[test]
    fn an_audience_is_for_files_only() {
        let space = admin_like();
        for resource in [CHANNEL, CALENDAR] {
            assert_eq!(
                write(
                    &space,
                    resource,
                    at(Aim::Audience {
                        editor_reads: false
                    }),
                    read(resource),
                    PermissionSet::EMPTY,
                    None
                ),
                Err(RuleRefusal::BadRequest("audience_files_only"))
            );
        }
        // On a file, the readers of a channel get Read for free.
        let space = Editor {
            paid: Paid::Community,
            ..admin_like()
        };
        assert_eq!(
            write(
                &space,
                FILE,
                at(Aim::Audience {
                    editor_reads: false
                }),
                read(FILE),
                PermissionSet::EMPTY,
                None
            ),
            Ok(())
        );
    }

    #[test]
    fn fine_rules_and_custom_roles_are_paid() {
        let custom_role = at(Aim::Role {
            position: 5,
            system: false,
            editor_holds: false,
        });
        let someone = at(Aim::User {
            is_editor: false,
            rank: Rank::Position(0),
            guest: false,
        });
        let files_view = set(&[P::FilesView]);
        let cases: Vec<(TargetRef, PermissionSet, PermissionSet)> = vec![
            // A custom role as a target, even at a preset level.
            (custom_role, read(FILE), PermissionSet::EMPTY),
            // A deny for a group or a person.
            (group(), PermissionSet::EMPTY, files_view),
            (someone, read(FILE), files_view),
            // Sets matching no preset.
            (
                group(),
                set(&[P::FilesView, P::FilesEdit]),
                PermissionSet::EMPTY,
            ),
            (
                at(Aim::Everyone { guests: false }),
                set(&[P::FilesView, P::FilesEdit]),
                PermissionSet::EMPTY,
            ),
        ];
        for (target, allow, deny) in cases {
            let mut space = admin_like();
            space.paid = Paid::Community;
            assert_eq!(
                write(&space, FILE, target, allow, deny, None),
                Err(RuleRefusal::LicenceRequired),
                "{target:?}"
            );
            space.paid = Paid::Frozen;
            assert_eq!(
                write(&space, FILE, target, allow, deny, None),
                Err(RuleRefusal::LicenceFrozen),
                "{target:?}"
            );
            space.paid = Paid::Enterprise;
            assert_eq!(
                write(&space, FILE, target, allow, deny, None),
                Ok(()),
                "{target:?}"
            );
        }
        // A preset level for a group or a person stays free.
        assert_eq!(
            write(
                &admin_like(),
                FILE,
                group(),
                read(FILE),
                PermissionSet::EMPTY,
                None
            ),
            Ok(())
        );
    }

    #[test]
    fn removing_a_rule_is_as_free_as_the_rule_it_removes() {
        let preset = Existing {
            allow: read(FILE),
            deny: PermissionSet::EMPTY,
        };
        let fine = Existing {
            allow: PermissionSet::EMPTY,
            deny: set(&[P::FilesView]),
        };
        let space = admin_like();
        // A preset level goes without a licence (writing nothing over it).
        assert_eq!(
            write(
                &space,
                FILE,
                group(),
                PermissionSet::EMPTY,
                PermissionSet::EMPTY,
                Some(preset)
            ),
            Ok(())
        );
        // A fine rule keeps asking for one, and for a thawed one.
        assert_eq!(
            write(
                &space,
                FILE,
                group(),
                PermissionSet::EMPTY,
                PermissionSet::EMPTY,
                Some(fine)
            ),
            Err(RuleRefusal::LicenceRequired)
        );
        let mut frozen = admin_like();
        frozen.paid = Paid::Frozen;
        assert_eq!(
            write(
                &frozen,
                FILE,
                group(),
                PermissionSet::EMPTY,
                PermissionSet::EMPTY,
                Some(fine)
            ),
            Err(RuleRefusal::LicenceFrozen)
        );
    }

    #[test]
    fn refusals_map_to_their_http_errors() {
        let url = "https://example.org/pricing";
        assert!(matches!(
            RuleRefusal::LicenceRequired.into_api(url),
            ApiError::LicenceRequired { .. }
        ));
        assert!(matches!(
            RuleRefusal::LicenceFrozen.into_api(url),
            ApiError::LicenceFrozen
        ));
        assert!(matches!(
            RuleRefusal::Forbidden("cannot_grant").into_api(url),
            ApiError::ForbiddenBecause("cannot_grant")
        ));
        assert!(matches!(
            RuleRefusal::Forbidden("target_above_you").into_api(url),
            ApiError::ForbiddenBecause("target_above_you")
        ));
        assert!(matches!(
            RuleRefusal::Forbidden("reservation_admins_only").into_api(url),
            ApiError::ForbiddenBecause("reservation_admins_only")
        ));
        for code in ["not_in_space", "audience_files_only"] {
            assert!(matches!(
                RuleRefusal::BadRequest(code).into_api(url),
                ApiError::BadRequestCode { code: c, .. } if c == code
            ));
        }
        assert!(matches!(
            RuleRefusal::BadRequest("guest_ceiling").into_api(url),
            ApiError::BadRequestCode {
                code: "guest_ceiling",
                ..
            }
        ));
    }
}
