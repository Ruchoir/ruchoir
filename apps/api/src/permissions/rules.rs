//! Who edits a resource's access, and the one check every rule write goes through (permissions
//! lot 4, ruling 4).
//!
//! [`editor_of`] says whether, and as what, someone may edit the access of a channel, a file or
//! folder, or a calendar ([`EditorKind`]); [`ensure_writable`] is the pure decision over that editor
//! and the rule they want to write, so the route, the dialog's `may` block and the tests cannot
//! disagree. The refusals come in a fixed order ([`RuleRefusal`]).

#![allow(dead_code)] // Read by the rule routes (permissions lot 4, task 4 part B).

use sea_orm::{ConnectionTrait, DbBackend, DbErr, Statement};
use uuid::Uuid;

use super::catalogue::{Permission, PermissionSet};
use super::check::{effective, space_rights, standing, Resource};
use super::delegation::{rank_of, Rank};
use super::engine::Standing;
use super::groups::Paid;
use super::levels::{level_of, Kind, LevelRead, Target};
use super::system_roles::GUEST_CEILING;
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

    fn engine(self) -> Resource {
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
    let rights = effective(&state.db, space_id, user_id, resource.engine()).await?;
    let facts = EditorFacts {
        owner: rank == Rank::Owner,
        space_manage: space_rights(&state.db, space_id, user_id)
            .await?
            .contains(resource.manage()),
        channel_moderator: moderator && !guest,
        author: author && !guest,
        local_manage: rights.contains(resource.manage()),
    };
    let Some(kind) = pick_kind(facts) else {
        return Ok(None);
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
    /// A role at `position` (Administrator included when `system`).
    Role { position: i32, system: bool },
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
    /// The readers of a channel (files only).
    Audience,
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
            Aim::Audience => Target::Audience,
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
    // Rule 3: no deny, and no change of a stored rule, aimed at oneself or above.
    let strong = matches!(editor.kind, EditorKind::Owner | EditorKind::Space);
    if !strong && (!deny.is_empty() || existing.is_some()) && above_editor(editor, target) {
        return Err(RuleRefusal::Forbidden("target_above_you"));
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
    if target.aim == Aim::Audience && !matches!(resource, ResourceRef::File(_)) {
        return Err(RuleRefusal::BadRequest("audience_files_only"));
    }
    // Fine rules: a custom role as a target, or sets that are no preset level.
    let custom_role = matches!(target.aim, Aim::Role { system: false, .. });
    let fine = level_of(resource.kind(), target.level_target(), allow, deny) == LevelRead::Custom;
    if custom_role || fine {
        match editor.paid {
            Paid::Enterprise => {}
            Paid::Frozen => return Err(RuleRefusal::LicenceFrozen),
            Paid::Community => return Err(RuleRefusal::LicenceRequired),
        }
    }
    Ok(())
}

/// Whether the target is the editor, a group of theirs, or a role or person at or above their rank.
fn above_editor(editor: &Editor, target: &TargetRef) -> bool {
    match target.aim {
        // "Tout l'espace" is the base of the resource, not someone above the editor: its
        // "Aucun accès" is today's reservation, which every free editor already sets.
        Aim::Everyone { .. } => false,
        Aim::Role { position, .. } => !editor.rank.outranks_position(position),
        Aim::Group {
            editor_in,
            top_position,
        } => editor_in || top_position.is_some_and(|p| !editor.rank.outranks_position(p)),
        Aim::User {
            is_editor, rank, ..
        } => is_editor || !editor.rank.outranks(rank),
        Aim::Audience => false,
    }
}

/// A place that names a group or a role in a rule.
#[derive(Debug, Clone, PartialEq, Eq)]
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
                    system: true
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
                at(Aim::Audience),
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
        // A deny is not a grant: rule 2 looks at the allow only.
        assert_eq!(
            write(
                &author,
                FILE,
                at(Aim::Everyone { guests: false }),
                PermissionSet::EMPTY,
                set(&[P::FilesView]),
                None
            ),
            Ok(())
        );
        // The check runs before the later ones: the audience target is not reached.
        assert_eq!(
            write(
                &author,
                FILE,
                at(Aim::Audience),
                set(&[P::FilesEdit]),
                PermissionSet::EMPTY,
                None
            ),
            Err(RuleRefusal::Forbidden("cannot_grant"))
        );
    }

    #[test]
    fn nobody_lifts_a_rule_aimed_at_them_or_above_them() {
        let local = Editor {
            paid: Paid::Enterprise,
            rank: Rank::Position(10),
            ..editor(EditorKind::Local, PermissionSet::ALL)
        };
        let deny = set(&[P::FilesView]);
        let cases = [
            // The editor themselves.
            at(Aim::User {
                is_editor: true,
                rank: Rank::Position(10),
                guest: false,
            }),
            // A person at their rank, and above it.
            at(Aim::User {
                is_editor: false,
                rank: Rank::Position(10),
                guest: false,
            }),
            at(Aim::User {
                is_editor: false,
                rank: Rank::Owner,
                guest: false,
            }),
            // A group they are in, and one carrying a role at or above their rank.
            at(Aim::Group {
                editor_in: true,
                top_position: None,
            }),
            at(Aim::Group {
                editor_in: false,
                top_position: Some(10),
            }),
            // A role at or above their rank, "everyone" being position 0 or below.
            at(Aim::Role {
                position: 10,
                system: false,
            }),
            at(Aim::Role {
                position: 100,
                system: true,
            }),
        ];
        for target in cases {
            assert_eq!(
                write(&local, FILE, target, PermissionSet::EMPTY, deny, None),
                Err(RuleRefusal::Forbidden("target_above_you")),
                "{target:?}"
            );
        }
        // A change of what is stored counts as well, allow only.
        let stored = Some(Existing {
            allow: read(FILE),
            deny: PermissionSet::EMPTY,
        });
        let me = at(Aim::User {
            is_editor: true,
            rank: Rank::Position(10),
            guest: false,
        });
        assert_eq!(
            write(&local, FILE, me, read(FILE), PermissionSet::EMPTY, stored),
            Err(RuleRefusal::Forbidden("target_above_you"))
        );
        // "Everyone" is not above anyone: its deny and its changes stay open to every editor.
        let everyone = at(Aim::Everyone { guests: false });
        assert_eq!(
            write(&local, FILE, everyone, PermissionSet::EMPTY, deny, stored),
            Ok(())
        );
        // Below them it is fine, and a first allow is fine even for oneself.
        let below = at(Aim::User {
            is_editor: false,
            rank: Rank::Position(9),
            guest: false,
        });
        assert_eq!(
            write(&local, FILE, below, PermissionSet::EMPTY, deny, None),
            Ok(())
        );
        assert_eq!(
            write(&local, FILE, me, read(FILE), PermissionSet::EMPTY, None),
            Ok(())
        );
        // Owner and Space editors are not held by it.
        for kind in [EditorKind::Owner, EditorKind::Space] {
            let boss = Editor {
                paid: Paid::Enterprise,
                ..editor(kind, PermissionSet::ALL)
            };
            assert_eq!(
                write(&boss, FILE, me, read(FILE), PermissionSet::EMPTY, stored),
                Ok(()),
                "{kind:?}"
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
            Aim::Audience,
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
                    at(Aim::Audience),
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
                at(Aim::Audience),
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
            RuleRefusal::BadRequest("guest_ceiling").into_api(url),
            ApiError::BadRequestCode {
                code: "guest_ceiling",
                ..
            }
        ));
    }
}
