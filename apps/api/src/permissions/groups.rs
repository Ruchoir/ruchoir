//! Groups (design section 4): who may do what to one, decided in one place.
//!
//! [`decide`] is pure: it takes the actor ([`GroupActor`], what they hold and where they stand), the
//! group as loaded ([`GroupRow`]) and the act, and answers `Ok` or a [`Refusal`]. Every route that
//! changes a group asks it, and so does the `may` block of the group's DTO, so the screen and the
//! server cannot disagree.
//!
//! Vocabulary used below: GM is `groups.manage`; RM(r) is `roles.manage` with a rank above role
//! `r` (an owner always); ALL is RM on every role the group carries; MGR is being a manager of the
//! group without being a guest; an act "rests on MGR" when the actor is a manager and GM with ALL
//! would not already allow it.

use std::collections::{HashMap, HashSet};

use sea_orm::{ConnectionTrait, DbBackend, DbErr, Statement};
use uuid::Uuid;

use super::catalogue::{Permission, PermissionSet};
use super::check::space_rights;
use super::delegation::{actor_rank, Rank, RoleRow};
use super::membership::active_sql;
use crate::edition::Entitlement;
use crate::messaging::error::ApiError;
use crate::messaging::mentions::fold_ascii;
use crate::state::AppState;

/// Where a group comes from: made by hand, or mirrored from a directory (read-only here).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupSource {
    Manual,
    Directory,
}

/// A person in a group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupMember {
    pub user_id: Uuid,
    pub is_manager: bool,
    /// Their standing in the space is `guest`: a guest never acts as a manager.
    pub guest: bool,
}

/// A group with its people and the roles it carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupRow {
    pub id: Uuid,
    pub space_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub source: GroupSource,
    /// The import that made it (`<source>:<job id>`), when one did.
    pub imported_from: Option<String>,
    pub members: Vec<GroupMember>,
    pub roles: Vec<RoleRow>,
    /// Some access rule names this group: being in it opens (or closes) something, as a role does.
    pub named_by_rules: bool,
}

/// Every group of `space_id` by name, with members and roles: three queries whatever the count.
pub async fn groups_of<C: ConnectionTrait>(db: &C, space_id: Uuid) -> Result<Vec<GroupRow>, DbErr> {
    load(db, space_id, None).await
}

/// One group of `space_id`; `None` for an id that is not one of its groups (another space's too).
pub async fn group<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    id: Uuid,
) -> Result<Option<GroupRow>, DbErr> {
    Ok(load(db, space_id, Some(id)).await?.pop())
}

async fn load<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    only: Option<Uuid>,
) -> Result<Vec<GroupRow>, DbErr> {
    // `$2` is NULL for "all of them", so the three statements keep one shape.
    let filter: Option<Uuid> = only;
    let mut groups = Vec::new();
    for row in db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id, name::text AS name, description, source, imported_from, \
                    EXISTS (SELECT 1 FROM permission_overrides o \
                             WHERE o.space_id = space_groups.space_id \
                               AND o.group_id = space_groups.id) AS named_by_rules \
               FROM space_groups \
              WHERE space_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY space_groups.name, id",
            [space_id.into(), filter.into()],
        ))
        .await?
    {
        let source: String = row.try_get("", "source")?;
        groups.push(GroupRow {
            id: row.try_get("", "id")?,
            space_id,
            name: row.try_get("", "name")?,
            description: row.try_get("", "description")?,
            source: if source == "directory" {
                GroupSource::Directory
            } else {
                GroupSource::Manual
            },
            imported_from: row.try_get("", "imported_from")?,
            members: Vec::new(),
            roles: Vec::new(),
            named_by_rules: row.try_get("", "named_by_rules")?,
        });
    }
    let at: HashMap<Uuid, usize> = groups.iter().enumerate().map(|(i, g)| (g.id, i)).collect();
    for row in db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            concat!(
                "SELECT gm.group_id, gm.user_id, gm.is_manager, (sm.standing = 'guest') AS guest \
               FROM space_group_members gm \
               JOIN space_members sm ON sm.space_id = gm.space_id AND sm.user_id = gm.user_id \
              WHERE gm.space_id = $1 AND ($2::uuid IS NULL OR gm.group_id = $2) \
                AND ",
                active_sql!("sm"),
                " ORDER BY gm.user_id"
            ),
            [space_id.into(), filter.into()],
        ))
        .await?
    {
        let group_id: Uuid = row.try_get("", "group_id")?;
        if let Some(g) = at.get(&group_id).map(|i| &mut groups[*i]) {
            g.members.push(GroupMember {
                user_id: row.try_get("", "user_id")?,
                is_manager: row.try_get("", "is_manager")?,
                guest: row.try_get("", "guest")?,
            });
        }
    }
    for row in db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT gr.group_id, r.id, r.system_key, r.name::text AS name, r.colour, r.position, \
                    r.permissions \
               FROM space_group_roles gr JOIN space_roles r ON r.id = gr.role_id \
              WHERE gr.space_id = $1 AND ($2::uuid IS NULL OR gr.group_id = $2) \
              ORDER BY r.position DESC, r.id",
            [space_id.into(), filter.into()],
        ))
        .await?
    {
        let group_id: Uuid = row.try_get("", "group_id")?;
        if let Some(g) = at.get(&group_id).map(|i| &mut groups[*i]) {
            g.roles.push(RoleRow {
                id: row.try_get("", "id")?,
                system_key: row.try_get("", "system_key")?,
                name: row.try_get("", "name")?,
                colour: row.try_get("", "colour")?,
                position: row.try_get("", "position")?,
                permissions: PermissionSet::from_names(
                    &row.try_get::<Vec<String>>("", "permissions")?,
                ),
            });
        }
    }
    Ok(groups)
}

/// What the space's licence allows, as [`decide`] reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Paid {
    Enterprise,
    Frozen,
    Community,
}

impl From<&Entitlement> for Paid {
    fn from(entitlement: &Entitlement) -> Self {
        match entitlement {
            Entitlement::Enterprise { .. } => Paid::Enterprise,
            Entitlement::Frozen { .. } => Paid::Frozen,
            Entitlement::Community => Paid::Community,
        }
    }
}

/// Who is acting on a group, as [`decide`] needs to know them.
#[derive(Debug, Clone)]
pub struct GroupActor {
    pub user_id: Uuid,
    pub owner: bool,
    pub rank: Rank,
    /// Their rights on the space itself.
    pub rights: PermissionSet,
    pub paid: Paid,
}

/// `user_id` as an actor of `space_id`, or `None` when they are not in it.
pub async fn actor(
    state: &AppState,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Option<GroupActor>, ApiError> {
    let Some(rank) = actor_rank(&state.db, space_id, user_id).await? else {
        return Ok(None);
    };
    let rights = space_rights(&state.db, space_id, user_id).await?;
    let paid = Paid::from(&state.edition.entitlement(&state.db, space_id).await?);
    Ok(Some(GroupActor {
        user_id,
        owner: rank == Rank::Owner,
        rank,
        rights,
        paid,
    }))
}

/// What is asked of a group.
#[derive(Debug, Clone, Copy)]
pub enum GroupAct<'a> {
    /// Rename it or change its description.
    Edit,
    Delete,
    /// Put these people in it.
    Add(&'a [Uuid]),
    /// Take these people out of it.
    Remove(&'a [Uuid]),
    /// The actor leaves it themselves.
    Leave,
    /// Make `after` the roles it carries.
    SetRoles {
        after: &'a [RoleRow],
    },
    /// Make these people its managers.
    SetManagers(&'a [Uuid]),
}

/// Why [`decide`] said no.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Forbidden,
    /// A `403` with its reason code.
    Because(&'static str),
    NotFound,
    /// The group is mirrored from a directory (`409 group_from_directory`).
    FromDirectory,
    /// `402 licence_required`; the mapping adds where to buy one.
    LicenceRequired,
    LicenceFrozen,
    /// `400 base_role_not_allowed`.
    BaseRole,
    /// `400 manager_must_be_member`.
    ManagerMustBeMember,
}

impl Refusal {
    /// The HTTP error, with where to buy a licence for the one that needs it.
    pub fn into_api(self, pricing_url: &str) -> ApiError {
        match self {
            Refusal::Forbidden => ApiError::Forbidden,
            Refusal::Because(code) => ApiError::ForbiddenBecause(code),
            Refusal::NotFound => ApiError::NotFound,
            Refusal::FromDirectory => ApiError::ConflictCode {
                code: "group_from_directory",
                message: "This group comes from a directory and cannot be changed by hand.",
            },
            Refusal::LicenceRequired => ApiError::LicenceRequired {
                pricing_url: pricing_url.to_owned(),
            },
            Refusal::LicenceFrozen => ApiError::LicenceFrozen,
            Refusal::BaseRole => ApiError::BadRequestCode {
                code: "base_role_not_allowed",
                message: "A group cannot carry the members or guests role.",
            },
            Refusal::ManagerMustBeMember => ApiError::BadRequestCode {
                code: "manager_must_be_member",
                message: "A manager must be a member of the group, and not a guest.",
            },
        }
    }
}

fn paid(actor: &GroupActor) -> Result<(), Refusal> {
    match actor.paid {
        Paid::Enterprise => Ok(()),
        Paid::Frozen => Err(Refusal::LicenceFrozen),
        Paid::Community => Err(Refusal::LicenceRequired),
    }
}

/// RM(r): `roles.manage` and a rank above `role`, or an owner.
fn manages_role(actor: &GroupActor, role: &RoleRow) -> bool {
    actor.owner
        || (actor.rights.contains(Permission::RolesManage)
            && actor.rank.outranks_position(role.position))
}

/// The ids of `roles`.
fn role_ids(roles: &[RoleRow]) -> HashSet<Uuid> {
    roles.iter().map(|r| r.id).collect()
}

/// Whether an add or a remove on `group` rests on the actor being its manager rather than on
/// `groups.manage` with every carried role under their rank. Such an act, on a group that carries
/// roles, also needs the actor to outrank each person it touches (see
/// [`super::group_routes`]), which is a question about other people and so not asked here.
pub fn rests_on_manager(actor: &GroupActor, group: &GroupRow) -> bool {
    let gm = actor.rights.contains(Permission::GroupsManage);
    let all = group.roles.iter().all(|r| manages_role(actor, r));
    let mgr = group
        .members
        .iter()
        .find(|m| m.user_id == actor.user_id)
        .is_some_and(|m| m.is_manager && !m.guest);
    mgr && !(gm && all)
}

/// Whether `actor` may do `act` to `group`; see the table in the permissions design (section 4).
pub fn decide(actor: &GroupActor, group: &GroupRow, act: GroupAct) -> Result<(), Refusal> {
    let gm = actor.rights.contains(Permission::GroupsManage);
    let all = group.roles.iter().all(|r| manages_role(actor, r));
    let carries = !group.roles.is_empty();
    let me = group.members.iter().find(|m| m.user_id == actor.user_id);
    let mgr = me.is_some_and(|m| m.is_manager && !m.guest);
    let from_directory = || {
        if group.source == GroupSource::Directory {
            Err(Refusal::FromDirectory)
        } else {
            Ok(())
        }
    };
    match act {
        GroupAct::Edit => {
            from_directory()?;
            if !gm {
                return Err(Refusal::Forbidden);
            }
            Ok(())
        }
        GroupAct::Delete => {
            from_directory()?;
            if !gm {
                return Err(Refusal::Forbidden);
            }
            if carries {
                paid(actor)?;
                if !all {
                    return Err(Refusal::Because("role_above_you"));
                }
            }
            Ok(())
        }
        GroupAct::Add(ids) | GroupAct::Remove(ids) => {
            from_directory()?;
            if !gm && !mgr {
                return Err(Refusal::Forbidden);
            }
            // The act rests on the manager's own right when GM with ALL would not allow it.
            let rests_on_mgr = mgr && !(gm && all);
            if carries || rests_on_mgr {
                paid(actor)?;
            }
            // On GM alone (not also a manager), a carried role above the actor stops them.
            if carries && !all && !mgr {
                return Err(Refusal::Because("role_above_you"));
            }
            // Nobody puts themselves in a group that gives something: a role it carries, or an
            // access rule that names it (a group rule lifts a private lock). An owner may.
            let gives_access = carries || (group.named_by_rules && matches!(act, GroupAct::Add(_)));
            if gives_access && !actor.owner && ids.contains(&actor.user_id) {
                return Err(Refusal::Because("no_self_role"));
            }
            if matches!(act, GroupAct::Remove(_))
                && rests_on_mgr
                && group
                    .members
                    .iter()
                    .any(|m| m.is_manager && m.user_id != actor.user_id && ids.contains(&m.user_id))
            {
                return Err(Refusal::Because("manager_protected"));
            }
            Ok(())
        }
        GroupAct::Leave => {
            from_directory()?;
            if me.is_none() {
                return Err(Refusal::NotFound);
            }
            Ok(())
        }
        GroupAct::SetRoles { after } => {
            paid(actor)?;
            if !gm || !actor.rights.contains(Permission::RolesManage) {
                return Err(Refusal::Forbidden);
            }
            if after
                .iter()
                .any(|r| matches!(r.system_key.as_deref(), Some("members" | "guests")))
            {
                return Err(Refusal::BaseRole);
            }
            let before_ids = role_ids(&group.roles);
            let after_ids = role_ids(after);
            let changed = group
                .roles
                .iter()
                .filter(|r| !after_ids.contains(&r.id))
                .chain(after.iter().filter(|r| !before_ids.contains(&r.id)));
            if changed.into_iter().any(|r| !manages_role(actor, r)) {
                return Err(Refusal::Because("role_above_you"));
            }
            if me.is_some() && !actor.owner {
                return Err(Refusal::Because("no_self_role"));
            }
            Ok(())
        }
        GroupAct::SetManagers(ids) => {
            from_directory()?;
            paid(actor)?;
            if !gm {
                return Err(Refusal::Forbidden);
            }
            if !all {
                return Err(Refusal::Because("role_above_you"));
            }
            if ids
                .iter()
                .any(|id| !group.members.iter().any(|m| m.user_id == *id && !m.guest))
            {
                return Err(Refusal::ManagerMustBeMember);
            }
            Ok(())
        }
    }
}

/// Words a group name may never be: they would shadow a broadcast mention.
const RESERVED: [&str; 7] = ["here", "ici", "channel", "everyone", "all", "canal", "tous"];

/// The longest group name, in characters.
const NAME_MAX: usize = 60;

/// A group name as it will be stored: trimmed, 1 to 60 characters, not starting like a mention or
/// a channel, and not a broadcast word. Uniqueness is the database's (citext) business.
pub fn validate_group_name(name: &str) -> Result<String, ApiError> {
    let name = name.trim();
    let length = name.chars().count();
    if length == 0 || length > NAME_MAX {
        return Err(ApiError::BadRequest("a group name has 1 to 60 characters"));
    }
    if name.chars().any(char::is_control) {
        return Err(ApiError::BadRequestCode {
            code: "group_name_invalid",
            message: "A group name cannot contain control characters.",
        });
    }
    if name.starts_with('@') || name.starts_with('#') {
        return Err(ApiError::BadRequest(
            "a group name cannot start with @ or #",
        ));
    }
    if RESERVED.contains(&fold_ascii(name).as_str()) {
        return Err(ApiError::BadRequestCode {
            code: "group_name_reserved",
            message: "This name is reserved for a mention of everyone.",
        });
    }
    Ok(name.to_owned())
}

/// `409 group_name_taken`, for the route that meets the unique index.
pub fn name_taken() -> ApiError {
    ApiError::ConflictCode {
        code: "group_name_taken",
        message: "A group of this space already has this name.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    const ME: u128 = 1;
    const OTHER: u128 = 2;
    const THIRD: u128 = 3;

    fn role(n: u128, position: i32) -> RoleRow {
        RoleRow {
            id: id(100 + n),
            system_key: None,
            name: format!("role{n}"),
            colour: None,
            position,
            permissions: PermissionSet::default(),
        }
    }

    fn base_role(key: &str) -> RoleRow {
        RoleRow {
            system_key: Some(key.to_owned()),
            ..role(90, 0)
        }
    }

    fn rights(list: &[Permission]) -> PermissionSet {
        let mut set = PermissionSet::default();
        for p in list {
            set.insert(*p);
        }
        set
    }

    fn actor_with(list: &[Permission], position: i32) -> GroupActor {
        GroupActor {
            user_id: id(ME),
            owner: false,
            rank: Rank::Position(position),
            rights: rights(list),
            paid: Paid::Enterprise,
        }
    }

    fn gm() -> GroupActor {
        actor_with(&[Permission::GroupsManage], 50)
    }

    fn gm_rm() -> GroupActor {
        actor_with(&[Permission::GroupsManage, Permission::RolesManage], 50)
    }

    fn plain() -> GroupActor {
        actor_with(&[], 0)
    }

    fn owner() -> GroupActor {
        GroupActor {
            owner: true,
            rank: Rank::Owner,
            rights: PermissionSet::default(),
            ..plain()
        }
    }

    fn member(n: u128, is_manager: bool, guest: bool) -> GroupMember {
        GroupMember {
            user_id: id(n),
            is_manager,
            guest,
        }
    }

    fn grp(members: Vec<GroupMember>, roles: Vec<RoleRow>) -> GroupRow {
        GroupRow {
            id: id(500),
            space_id: id(600),
            name: "Team".into(),
            description: None,
            source: GroupSource::Manual,
            imported_from: None,
            members,
            roles,
            named_by_rules: false,
        }
    }

    fn directory(members: Vec<GroupMember>) -> GroupRow {
        GroupRow {
            source: GroupSource::Directory,
            ..grp(members, vec![])
        }
    }

    fn because(code: &'static str) -> Result<(), Refusal> {
        Err(Refusal::Because(code))
    }

    // Edit

    #[test]
    fn decide_edit_needs_groups_manage() {
        let g = grp(vec![], vec![]);
        assert_eq!(decide(&gm(), &g, GroupAct::Edit), Ok(()));
        assert_eq!(
            decide(&plain(), &g, GroupAct::Edit),
            Err(Refusal::Forbidden)
        );
        // A manager of the group is not enough to rename it.
        let g = grp(vec![member(ME, true, false)], vec![]);
        assert_eq!(
            decide(&plain(), &g, GroupAct::Edit),
            Err(Refusal::Forbidden)
        );
    }

    #[test]
    fn decide_edit_refuses_a_directory_group_before_rights() {
        let g = directory(vec![]);
        assert_eq!(
            decide(&gm(), &g, GroupAct::Edit),
            Err(Refusal::FromDirectory)
        );
        assert_eq!(
            decide(&plain(), &g, GroupAct::Edit),
            Err(Refusal::FromDirectory)
        );
    }

    #[test]
    fn decide_edit_needs_no_licence_even_with_roles() {
        let mut a = gm();
        a.paid = Paid::Community;
        let g = grp(vec![], vec![role(1, 80)]);
        assert_eq!(decide(&a, &g, GroupAct::Edit), Ok(()));
    }

    // Delete

    #[test]
    fn decide_delete_needs_groups_manage_and_refuses_a_directory_group() {
        let g = grp(vec![], vec![]);
        assert_eq!(decide(&gm(), &g, GroupAct::Delete), Ok(()));
        assert_eq!(
            decide(&plain(), &g, GroupAct::Delete),
            Err(Refusal::Forbidden)
        );
        assert_eq!(
            decide(&gm(), &directory(vec![]), GroupAct::Delete),
            Err(Refusal::FromDirectory)
        );
    }

    #[test]
    fn decide_delete_plain_group_is_free_of_licence() {
        let mut a = gm();
        a.paid = Paid::Community;
        assert_eq!(decide(&a, &grp(vec![], vec![]), GroupAct::Delete), Ok(()));
    }

    #[test]
    fn decide_delete_role_carrying_group_needs_a_licence() {
        let g = grp(vec![], vec![role(1, 10)]);
        let mut a = gm_rm();
        a.paid = Paid::Community;
        assert_eq!(
            decide(&a, &g, GroupAct::Delete),
            Err(Refusal::LicenceRequired)
        );
        a.paid = Paid::Frozen;
        assert_eq!(
            decide(&a, &g, GroupAct::Delete),
            Err(Refusal::LicenceFrozen)
        );
    }

    #[test]
    fn decide_delete_role_carrying_group_needs_every_role() {
        let g = grp(vec![], vec![role(1, 10), role(2, 60)]);
        assert_eq!(
            decide(&gm_rm(), &g, GroupAct::Delete),
            because("role_above_you")
        );
        // Without roles.manage at all.
        let g = grp(vec![], vec![role(1, 10)]);
        assert_eq!(
            decide(&gm(), &g, GroupAct::Delete),
            because("role_above_you")
        );
        // Equal position is not above.
        let g = grp(vec![], vec![role(1, 50)]);
        assert_eq!(
            decide(&gm_rm(), &g, GroupAct::Delete),
            because("role_above_you")
        );
        // An owner needs nothing but the licence.
        let g = grp(vec![], vec![role(1, 99)]);
        assert_eq!(decide(&owner_with_rights(), &g, GroupAct::Delete), Ok(()));
        let g = grp(vec![], vec![role(1, 10), role(2, 49)]);
        assert_eq!(decide(&gm_rm(), &g, GroupAct::Delete), Ok(()));
    }

    #[test]
    fn decide_delete_licence_is_asked_before_the_roles() {
        let mut a = gm();
        a.paid = Paid::Community;
        let g = grp(vec![], vec![role(1, 90)]);
        assert_eq!(
            decide(&a, &g, GroupAct::Delete),
            Err(Refusal::LicenceRequired)
        );
    }

    // Add

    #[test]
    fn decide_add_refuses_oneself_to_a_group_that_a_rule_names() {
        let mine = [id(ME)];
        let others = [id(OTHER)];
        let mut g = grp(vec![], vec![]);
        g.named_by_rules = true;
        assert_eq!(
            decide(&gm(), &g, GroupAct::Add(&mine)),
            because("no_self_role")
        );
        assert_eq!(decide(&gm(), &g, GroupAct::Add(&others)), Ok(()));
        assert_eq!(
            decide(&owner_with_rights(), &g, GroupAct::Add(&mine)),
            Ok(())
        );
        // Taking oneself out of it is not giving oneself anything.
        assert_eq!(decide(&gm(), &g, GroupAct::Remove(&mine)), Ok(()));
        // A group no rule names stays free.
        assert_eq!(
            decide(&gm(), &grp(vec![], vec![]), GroupAct::Add(&mine)),
            Ok(())
        );
    }

    #[test]
    fn decide_add_directory_first_then_neither_gm_nor_manager() {
        let others = [id(OTHER)];
        assert_eq!(
            decide(&gm(), &directory(vec![]), GroupAct::Add(&others)),
            Err(Refusal::FromDirectory)
        );
        let g = grp(vec![member(ME, false, false)], vec![]);
        assert_eq!(
            decide(&plain(), &g, GroupAct::Add(&others)),
            Err(Refusal::Forbidden)
        );
        // A guest manager is no manager.
        let g = grp(vec![member(ME, true, true)], vec![]);
        assert_eq!(
            decide(&plain(), &g, GroupAct::Add(&others)),
            Err(Refusal::Forbidden)
        );
    }

    #[test]
    fn decide_add_gm_to_a_plain_group_needs_no_licence() {
        let others = [id(OTHER)];
        let mut a = gm();
        a.paid = Paid::Community;
        assert_eq!(
            decide(&a, &grp(vec![], vec![]), GroupAct::Add(&others)),
            Ok(())
        );
    }

    #[test]
    fn decide_add_a_manager_needs_a_licence_even_for_a_plain_group() {
        let others = [id(OTHER)];
        let g = grp(vec![member(ME, true, false)], vec![]);
        let mut a = plain();
        assert_eq!(decide(&a, &g, GroupAct::Add(&others)), Ok(()));
        a.paid = Paid::Community;
        assert_eq!(
            decide(&a, &g, GroupAct::Add(&others)),
            Err(Refusal::LicenceRequired)
        );
        a.paid = Paid::Frozen;
        assert_eq!(
            decide(&a, &g, GroupAct::Add(&others)),
            Err(Refusal::LicenceFrozen)
        );
    }

    #[test]
    fn decide_add_gm_with_all_who_is_also_manager_rests_on_gm_not_mgr() {
        // A plain group: GM with ALL (vacuous) allows it, so no licence is asked.
        let others = [id(OTHER)];
        let mut a = gm();
        a.paid = Paid::Community;
        let g = grp(vec![member(ME, true, false)], vec![]);
        assert_eq!(decide(&a, &g, GroupAct::Add(&others)), Ok(()));
    }

    #[test]
    fn decide_add_carrying_group_needs_a_licence() {
        let others = [id(OTHER)];
        let g = grp(vec![], vec![role(1, 10)]);
        let mut a = gm_rm();
        a.paid = Paid::Community;
        assert_eq!(
            decide(&a, &g, GroupAct::Add(&others)),
            Err(Refusal::LicenceRequired)
        );
    }

    #[test]
    fn decide_add_on_gm_alone_needs_every_role() {
        let others = [id(OTHER)];
        let g = grp(vec![], vec![role(1, 80)]);
        assert_eq!(
            decide(&gm_rm(), &g, GroupAct::Add(&others)),
            because("role_above_you")
        );
        let g = grp(vec![], vec![role(1, 10)]);
        assert_eq!(decide(&gm_rm(), &g, GroupAct::Add(&others)), Ok(()));
    }

    #[test]
    fn decide_add_a_manager_may_add_to_a_group_with_roles_above_them() {
        let others = [id(OTHER)];
        let g = grp(vec![member(ME, true, false)], vec![role(1, 80)]);
        assert_eq!(decide(&plain(), &g, GroupAct::Add(&others)), Ok(()));
        // GM without ALL who is also a manager rests on MGR.
        assert_eq!(decide(&gm(), &g, GroupAct::Add(&others)), Ok(()));
    }

    #[test]
    fn decide_add_nobody_gives_themselves_a_role() {
        let mine = [id(ME)];
        let g = grp(vec![member(ME, true, false)], vec![role(1, 10)]);
        assert_eq!(
            decide(&plain(), &g, GroupAct::Add(&mine)),
            because("no_self_role")
        );
        assert_eq!(
            decide(
                &gm_rm(),
                &grp(vec![], vec![role(1, 10)]),
                GroupAct::Add(&mine)
            ),
            because("no_self_role")
        );
        // An owner may; so may anyone joining a group without a role.
        assert_eq!(
            decide(
                &owner_with_rights(),
                &grp(vec![], vec![role(1, 10)]),
                GroupAct::Add(&mine)
            ),
            Ok(())
        );
        assert_eq!(
            decide(&gm(), &grp(vec![], vec![]), GroupAct::Add(&mine)),
            Ok(())
        );
    }

    // Remove

    #[test]
    fn decide_remove_follows_add() {
        let others = [id(OTHER)];
        assert_eq!(
            decide(&gm(), &directory(vec![]), GroupAct::Remove(&others)),
            Err(Refusal::FromDirectory)
        );
        let g = grp(vec![member(ME, false, false)], vec![]);
        assert_eq!(
            decide(&plain(), &g, GroupAct::Remove(&others)),
            Err(Refusal::Forbidden)
        );
        let g = grp(vec![], vec![role(1, 80)]);
        assert_eq!(
            decide(&gm_rm(), &g, GroupAct::Remove(&others)),
            because("role_above_you")
        );
        let mut a = gm();
        a.paid = Paid::Community;
        assert_eq!(
            decide(&a, &grp(vec![], vec![]), GroupAct::Remove(&others)),
            Ok(())
        );
        let g = grp(vec![member(ME, true, false)], vec![]);
        let mut a = plain();
        a.paid = Paid::Community;
        assert_eq!(
            decide(&a, &g, GroupAct::Remove(&others)),
            Err(Refusal::LicenceRequired)
        );
    }

    #[test]
    fn decide_remove_yourself_from_a_carrying_group_is_leave_not_remove() {
        let mine = [id(ME)];
        let g = grp(vec![member(ME, true, false)], vec![role(1, 10)]);
        assert_eq!(
            decide(&plain(), &g, GroupAct::Remove(&mine)),
            because("no_self_role")
        );
    }

    #[test]
    fn decide_remove_a_manager_cannot_remove_another_manager() {
        let g = grp(
            vec![member(ME, true, false), member(OTHER, true, false)],
            vec![],
        );
        assert_eq!(
            decide(&plain(), &g, GroupAct::Remove(&[id(OTHER)])),
            because("manager_protected")
        );
        // An ordinary member is fine to remove.
        let g = grp(
            vec![member(ME, true, false), member(THIRD, false, false)],
            vec![],
        );
        assert_eq!(decide(&plain(), &g, GroupAct::Remove(&[id(THIRD)])), Ok(()));
    }

    #[test]
    fn decide_remove_a_manager_who_also_holds_gm_with_all_may_remove_managers() {
        let g = grp(
            vec![member(ME, true, false), member(OTHER, true, false)],
            vec![],
        );
        assert_eq!(decide(&gm(), &g, GroupAct::Remove(&[id(OTHER)])), Ok(()));
    }

    #[test]
    fn decide_remove_gm_without_all_but_manager_rests_on_mgr_and_is_protected() {
        let g = grp(
            vec![member(ME, true, false), member(OTHER, true, false)],
            vec![role(1, 80)],
        );
        assert_eq!(
            decide(&gm(), &g, GroupAct::Remove(&[id(OTHER)])),
            because("manager_protected")
        );
    }

    #[test]
    fn decide_remove_gm_not_manager_may_remove_a_manager() {
        let g = grp(vec![member(OTHER, true, false)], vec![]);
        assert_eq!(decide(&gm(), &g, GroupAct::Remove(&[id(OTHER)])), Ok(()));
    }

    // Leave

    #[test]
    fn decide_leave_is_for_members_only() {
        let g = grp(vec![member(ME, false, false)], vec![role(1, 90)]);
        assert_eq!(decide(&plain(), &g, GroupAct::Leave), Ok(()));
        let g = grp(vec![member(OTHER, false, false)], vec![]);
        assert_eq!(
            decide(&plain(), &g, GroupAct::Leave),
            Err(Refusal::NotFound)
        );
    }

    #[test]
    fn decide_leave_works_in_any_licence_state() {
        let g = grp(vec![member(ME, true, false)], vec![role(1, 90)]);
        for state in [Paid::Community, Paid::Frozen, Paid::Enterprise] {
            let mut a = plain();
            a.paid = state;
            assert_eq!(decide(&a, &g, GroupAct::Leave), Ok(()));
        }
    }

    #[test]
    fn decide_leave_refuses_a_directory_group() {
        let g = directory(vec![member(ME, false, false)]);
        assert_eq!(
            decide(&plain(), &g, GroupAct::Leave),
            Err(Refusal::FromDirectory)
        );
        // Directory is asked before membership.
        let g = directory(vec![]);
        assert_eq!(
            decide(&plain(), &g, GroupAct::Leave),
            Err(Refusal::FromDirectory)
        );
    }

    // SetRoles

    #[test]
    fn decide_set_roles_needs_a_licence_first() {
        let after = [role(1, 10)];
        let g = grp(vec![], vec![]);
        let mut a = plain();
        a.paid = Paid::Community;
        assert_eq!(
            decide(&a, &g, GroupAct::SetRoles { after: &after }),
            Err(Refusal::LicenceRequired)
        );
        a.paid = Paid::Frozen;
        assert_eq!(
            decide(&a, &g, GroupAct::SetRoles { after: &after }),
            Err(Refusal::LicenceFrozen)
        );
    }

    #[test]
    fn decide_set_roles_needs_groups_manage_and_roles_manage() {
        let after = [role(1, 10)];
        let g = grp(vec![], vec![]);
        for a in [plain(), gm(), actor_with(&[Permission::RolesManage], 50)] {
            assert_eq!(
                decide(&a, &g, GroupAct::SetRoles { after: &after }),
                Err(Refusal::Forbidden)
            );
        }
        assert_eq!(
            decide(&gm_rm(), &g, GroupAct::SetRoles { after: &after }),
            Ok(())
        );
    }

    #[test]
    fn decide_set_roles_refuses_a_base_role() {
        let g = grp(vec![], vec![]);
        for key in ["members", "guests"] {
            let after = [role(1, 10), base_role(key)];
            assert_eq!(
                decide(&gm_rm(), &g, GroupAct::SetRoles { after: &after }),
                Err(Refusal::BaseRole)
            );
        }
        // The administrator role is a system role but not a base one.
        let admin = RoleRow {
            system_key: Some("administrator".into()),
            ..role(2, 40)
        };
        assert_eq!(
            decide(&gm_rm(), &g, GroupAct::SetRoles { after: &[admin] }),
            Ok(())
        );
    }

    #[test]
    fn decide_set_roles_checks_the_roles_added_and_removed_only() {
        let high = role(1, 80);
        let low = role(2, 10);
        // Adding a role above the actor.
        let g = grp(vec![], vec![low.clone()]);
        assert_eq!(
            decide(
                &gm_rm(),
                &g,
                GroupAct::SetRoles {
                    after: &[low.clone(), high.clone()]
                }
            ),
            because("role_above_you")
        );
        // Removing one.
        let g = grp(vec![], vec![low.clone(), high.clone()]);
        assert_eq!(
            decide(
                &gm_rm(),
                &g,
                GroupAct::SetRoles {
                    after: std::slice::from_ref(&low)
                }
            ),
            because("role_above_you")
        );
        // Keeping a role above the actor, changing a lower one: fine.
        assert_eq!(
            decide(
                &gm_rm(),
                &g,
                GroupAct::SetRoles {
                    after: &[high.clone(), role(3, 20)]
                }
            ),
            Ok(())
        );
        // An owner is above everything.
        assert_eq!(
            decide(&owner_with_rights(), &g, GroupAct::SetRoles { after: &[] }),
            Ok(())
        );
    }

    fn owner_with_rights() -> GroupActor {
        GroupActor {
            rights: rights(&[Permission::GroupsManage, Permission::RolesManage]),
            ..owner()
        }
    }

    #[test]
    fn decide_set_roles_nobody_gives_themselves_a_role() {
        let after = [role(1, 10)];
        let g = grp(vec![member(ME, false, false)], vec![]);
        assert_eq!(
            decide(&gm_rm(), &g, GroupAct::SetRoles { after: &after }),
            because("no_self_role")
        );
        assert_eq!(
            decide(
                &owner_with_rights(),
                &g,
                GroupAct::SetRoles { after: &after }
            ),
            Ok(())
        );
        let g = grp(vec![member(OTHER, false, false)], vec![]);
        assert_eq!(
            decide(&gm_rm(), &g, GroupAct::SetRoles { after: &after }),
            Ok(())
        );
    }

    #[test]
    fn decide_set_roles_on_a_directory_group_is_not_refused_for_its_source() {
        let after = [role(1, 10)];
        assert_eq!(
            decide(
                &gm_rm(),
                &directory(vec![]),
                GroupAct::SetRoles { after: &after }
            ),
            Ok(())
        );
    }

    // SetManagers

    #[test]
    fn decide_pins_the_order_of_refusals() {
        let others = [id(OTHER)];
        let mine = [id(ME)];
        // Add: licence before role_above_you.
        let g = grp(vec![], vec![role(1, 80)]);
        let mut a = gm_rm();
        a.paid = Paid::Community;
        assert_eq!(
            decide(&a, &g, GroupAct::Add(&others)),
            Err(Refusal::LicenceRequired)
        );
        // Add: role_above_you before no_self_role.
        assert_eq!(
            decide(&gm_rm(), &g, GroupAct::Add(&mine)),
            because("role_above_you")
        );
        // Add: GM and MGR without ALL, Community: the act rests on MGR, so the licence.
        let g = grp(vec![member(ME, true, false)], vec![role(1, 80)]);
        let mut a = gm();
        a.paid = Paid::Community;
        assert_eq!(
            decide(&a, &g, GroupAct::Add(&others)),
            Err(Refusal::LicenceRequired)
        );
        // SetRoles: Forbidden before base_role_not_allowed.
        let g = grp(vec![], vec![]);
        let after = [base_role("members")];
        assert_eq!(
            decide(&gm(), &g, GroupAct::SetRoles { after: &after }),
            Err(Refusal::Forbidden)
        );
        // SetRoles: base_role_not_allowed before role_above_you.
        let after = [base_role("members"), role(1, 80)];
        assert_eq!(
            decide(&gm_rm(), &g, GroupAct::SetRoles { after: &after }),
            Err(Refusal::BaseRole)
        );
        // SetManagers: directory before licence.
        let mut a = gm();
        a.paid = Paid::Community;
        assert_eq!(
            decide(&a, &directory(vec![]), GroupAct::SetManagers(&others)),
            Err(Refusal::FromDirectory)
        );
    }

    #[test]
    fn group_name_refuses_control_characters() {
        for name in ["a\nb", "a\tb", "a\u{0}b", "a\u{7f}b"] {
            assert!(
                matches!(
                    validate_group_name(name),
                    Err(ApiError::BadRequestCode {
                        code: "group_name_invalid",
                        ..
                    })
                ),
                "{name:?}"
            );
        }
        // Surrounding whitespace is trimmed first, not refused.
        assert_eq!(validate_group_name("\n Design\t").unwrap(), "Design");
    }

    #[test]
    fn decide_set_managers_order_directory_licence_rights_roles() {
        let ids = [id(OTHER)];
        let g = grp(vec![member(OTHER, false, false)], vec![]);
        assert_eq!(
            decide(&gm(), &directory(vec![]), GroupAct::SetManagers(&ids)),
            Err(Refusal::FromDirectory)
        );
        let mut a = plain();
        a.paid = Paid::Community;
        assert_eq!(
            decide(&a, &g, GroupAct::SetManagers(&ids)),
            Err(Refusal::LicenceRequired)
        );
        a.paid = Paid::Frozen;
        assert_eq!(
            decide(&a, &g, GroupAct::SetManagers(&ids)),
            Err(Refusal::LicenceFrozen)
        );
        assert_eq!(
            decide(&plain(), &g, GroupAct::SetManagers(&ids)),
            Err(Refusal::Forbidden)
        );
        assert_eq!(decide(&gm(), &g, GroupAct::SetManagers(&ids)), Ok(()));
    }

    #[test]
    fn decide_set_managers_needs_every_role() {
        let ids = [id(OTHER)];
        let g = grp(vec![member(OTHER, false, false)], vec![role(1, 80)]);
        assert_eq!(
            decide(&gm_rm(), &g, GroupAct::SetManagers(&ids)),
            because("role_above_you")
        );
        assert_eq!(
            decide(&owner_with_rights(), &g, GroupAct::SetManagers(&ids)),
            Ok(())
        );
    }

    #[test]
    fn decide_set_managers_must_be_members_and_not_guests() {
        let g = grp(
            vec![member(OTHER, false, false), member(THIRD, false, true)],
            vec![],
        );
        assert_eq!(
            decide(&gm(), &g, GroupAct::SetManagers(&[id(99)])),
            Err(Refusal::ManagerMustBeMember)
        );
        assert_eq!(
            decide(&gm(), &g, GroupAct::SetManagers(&[id(THIRD)])),
            Err(Refusal::ManagerMustBeMember)
        );
        assert_eq!(decide(&gm(), &g, GroupAct::SetManagers(&[])), Ok(()));
    }

    // Mapping

    #[test]
    fn refusals_map_to_their_http_errors() {
        let url = "https://example.test/pricing";
        assert!(matches!(
            Refusal::Forbidden.into_api(url),
            ApiError::Forbidden
        ));
        assert!(matches!(
            Refusal::Because("no_self_role").into_api(url),
            ApiError::ForbiddenBecause("no_self_role")
        ));
        assert!(matches!(
            Refusal::NotFound.into_api(url),
            ApiError::NotFound
        ));
        assert!(matches!(
            Refusal::FromDirectory.into_api(url),
            ApiError::ConflictCode {
                code: "group_from_directory",
                ..
            }
        ));
        assert!(matches!(
            Refusal::LicenceRequired.into_api(url),
            ApiError::LicenceRequired { pricing_url } if pricing_url == url
        ));
        assert!(matches!(
            Refusal::LicenceFrozen.into_api(url),
            ApiError::LicenceFrozen
        ));
        assert!(matches!(
            Refusal::BaseRole.into_api(url),
            ApiError::BadRequestCode {
                code: "base_role_not_allowed",
                ..
            }
        ));
        assert!(matches!(
            Refusal::ManagerMustBeMember.into_api(url),
            ApiError::BadRequestCode {
                code: "manager_must_be_member",
                ..
            }
        ));
    }

    // Names

    #[test]
    fn group_name_is_trimmed_and_bounded() {
        assert_eq!(validate_group_name("  Design  ").unwrap(), "Design");
        assert!(validate_group_name("").is_err());
        assert!(validate_group_name("   ").is_err());
        assert!(validate_group_name(&"a".repeat(60)).is_ok());
        assert!(validate_group_name(&"a".repeat(61)).is_err());
        // Characters, not bytes.
        assert!(validate_group_name(&"é".repeat(60)).is_ok());
    }

    #[test]
    fn group_name_cannot_look_like_a_mention_or_a_channel() {
        assert!(validate_group_name("@design").is_err());
        assert!(validate_group_name("#design").is_err());
        assert!(validate_group_name("  @design").is_err());
        assert!(validate_group_name("de@sign").is_ok());
    }

    #[test]
    fn group_name_reserved_words_are_refused_folded() {
        for name in [
            "here", "ICI", "Channel", "everyone", "All", "canal", "Tous", " tous ", "ICÏ",
        ] {
            assert!(
                matches!(
                    validate_group_name(name),
                    Err(ApiError::BadRequestCode {
                        code: "group_name_reserved",
                        ..
                    })
                ),
                "{name}"
            );
        }
        assert!(matches!(
            validate_group_name("Tóus"),
            Err(ApiError::BadRequestCode {
                code: "group_name_reserved",
                ..
            })
        ));
        assert!(validate_group_name("Tous les jours").is_ok());
        assert!(validate_group_name("hereby").is_ok());
    }
}
