//! What resolution needs, read from the database: the people, the levels of a resource, its rules.
//!
//! Everything is read in bulk (a whole space's members, every rule of a set of channels at once),
//! so a single check and a sidebar of three hundred channels cost the same handful of queries. Two
//! guards live here rather than in every caller:
//!
//! - **A space missing its system roles is repaired** before anyone is resolved in it (a space
//!   written by hand, or the rows deleted): the new model is derived again from the old columns,
//!   rather than its members being locked out.
//! - **Only rows of the space being asked about are ever read**, so a channel, file or calendar of
//!   another space is never resolved against this space's roles.

use std::collections::{BTreeMap, HashMap, HashSet};

use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, DbErr, EntityTrait, FromQueryResult,
    QueryFilter, Statement,
};
use uuid::Uuid;

use super::catalogue::{Permission, PermissionSet};
use super::engine::{Facts, Level, LevelKind, Rule, Source, Standing, Subject, TargetRef, Whom};
use crate::entities::{
    calendars, channel_members, channels, conversations, dm_participants, permission_overrides,
};

/// What a permission is checked on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Resource {
    Space,
    Channel(Uuid),
    /// A file or a folder.
    File(Uuid),
    // The calendar code asks through `check::calendar_rights_many` (it runs inside transactions);
    // `explain` and the tests ask through this variant.
    #[allow(dead_code)]
    Calendar(Uuid),
}

/// A person of the space, as resolution sees them.
#[derive(Clone, Debug)]
pub(super) struct Person {
    pub user_id: Uuid,
    pub subject: Subject,
    /// The base role their standing implies (`@members` or `@guests`), which rules may target.
    pub base_role: Option<Uuid>,
    /// The groups they belong to.
    pub groups: Vec<Uuid>,
    /// Each role they hold through a group, with the groups of theirs that carry it.
    pub role_groups: HashMap<Uuid, Vec<Uuid>>,
    /// The channels whose readers they are (filled by the caller that needs it, empty at load).
    pub readable_audiences: HashSet<Uuid>,
    /// The roles they hold that are not system roles: the ones whose allow may open a private channel.
    pub custom_roles: HashSet<Uuid>,
    /// While the person previews a role: who they really are, which the preview never exceeds.
    pub ceiling: Option<Ceiling>,
}

/// The viewer behind a preview: their own subject, and what the rules need to match them.
#[derive(Clone, Debug)]
pub(super) struct Ceiling {
    pub subject: Subject,
    pub groups: Vec<Uuid>,
    pub custom_roles: HashSet<Uuid>,
}

/// A rule as stored, before it is matched to a person.
#[derive(Clone, Debug)]
pub(super) struct StoredRule {
    pub channel_id: Option<Uuid>,
    pub file_id: Option<Uuid>,
    pub calendar_id: Option<Uuid>,
    pub role_id: Option<Uuid>,
    pub user_id: Option<Uuid>,
    pub group_id: Option<Uuid>,
    pub audience_channel_id: Option<Uuid>,
    pub allow: PermissionSet,
    pub deny: PermissionSet,
}

impl Person {
    /// The stored rules that apply to this person, as the engine's rules, `first` ahead of the
    /// personal ones (a channel role is a personal rule that a rule on the person can still undo).
    pub fn rules<'a>(
        &self,
        stored: impl Iterator<Item = &'a StoredRule>,
        first: Option<Rule>,
    ) -> Vec<Rule> {
        // The channel role is the viewer's own, not the previewed role's (as is joining the
        // channel, which `check::resolved` leaves to the ceiling's side).
        let mut rules: Vec<Rule> = first
            .into_iter()
            .map(|rule| Rule {
                whom: if self.ceiling.is_some() {
                    Whom::Viewer
                } else {
                    rule.whom
                },
                ..rule
            })
            .collect();
        for rule in stored {
            // A preview is of a role, not of a person: the viewer's personal rules are theirs alone.
            let own = self.target_of(
                rule,
                &self.held_roles(),
                &self.groups,
                self.ceiling.is_none(),
            );
            let theirs = self.ceiling.as_ref().and_then(|ceiling| {
                let held: Vec<Uuid> = ceiling.subject.roles.iter().map(|(id, _)| *id).collect();
                self.target_of(rule, &held, &ceiling.groups, true)
            });
            let (target, whom) = match (own, theirs, self.ceiling.is_some()) {
                (Some(target), _, false) => (target, Whom::Both),
                (Some(target), Some(_), true) => (target, Whom::Both),
                (Some(target), None, true) => (target, Whom::Preview),
                (None, Some(target), true) => (target, Whom::Viewer),
                _ => continue,
            };
            let source = match target {
                TargetRef::BaseRole => Source::BaseRole,
                TargetRef::Role(role) => Source::Role(role),
                TargetRef::User => Source::User,
                TargetRef::Group(group) => Source::Group(group),
                TargetRef::Audience(channel) => Source::Audience(channel),
            };
            let custom = |role: Uuid| {
                self.custom_roles.contains(&role)
                    || self
                        .ceiling
                        .as_ref()
                        .is_some_and(|ceiling| ceiling.custom_roles.contains(&role))
            };
            let lifts_lock = match target {
                TargetRef::Role(role) => custom(role),
                TargetRef::User | TargetRef::Group(_) => true,
                TargetRef::BaseRole | TargetRef::Audience(_) => false,
            };
            rules.push(Rule {
                target,
                allow: rule.allow,
                deny: rule.deny,
                source,
                lifts_lock,
                whom,
            });
        }
        rules
    }

    fn held_roles(&self) -> Vec<Uuid> {
        self.subject.roles.iter().map(|(id, _)| *id).collect()
    }

    /// What a stored rule is aimed at, for somebody holding `roles` and belonging to `groups`
    /// (`personal`: whether rules aimed at the person count); `None` when it is not about them.
    fn target_of(
        &self,
        rule: &StoredRule,
        roles: &[Uuid],
        groups: &[Uuid],
        personal: bool,
    ) -> Option<TargetRef> {
        if let Some(role) = rule.role_id {
            if Some(role) == self.base_role {
                Some(TargetRef::BaseRole)
            } else if roles.contains(&role) {
                Some(TargetRef::Role(role))
            } else {
                None
            }
        } else if let Some(user) = rule.user_id {
            (personal && user == self.user_id).then_some(TargetRef::User)
        } else if let Some(group) = rule.group_id {
            groups.contains(&group).then_some(TargetRef::Group(group))
        } else if let Some(channel) = rule.audience_channel_id {
            self.readable_audiences
                .contains(&channel)
                .then_some(TargetRef::Audience(channel))
        } else {
            None
        }
    }
}

#[cfg(test)]
static ISSUED: std::sync::Mutex<Option<HashMap<Uuid, u64>>> = std::sync::Mutex::new(None);

/// Count one query made on behalf of a space (tests only: nothing is counted in production).
fn issued(space_id: Uuid) {
    #[cfg(test)]
    {
        let mut counts = ISSUED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *counts
            .get_or_insert_with(HashMap::new)
            .entry(space_id)
            .or_default() += 1;
    }
    #[cfg(not(test))]
    let _ = space_id;
}

/// How many queries the loader has made on behalf of a space since the process started. Counted
/// per space so tests running side by side do not count each other's.
#[cfg(test)]
pub fn queries_issued(space_id: Uuid) -> u64 {
    ISSUED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .and_then(|counts| counts.get(&space_id).copied())
        .unwrap_or(0)
}

#[cfg(test)]
static PEOPLE_READ: std::sync::Mutex<Option<HashMap<Uuid, u64>>> = std::sync::Mutex::new(None);

/// How many people the loader has read on behalf of a space since the process started (tests only).
#[cfg(test)]
pub fn people_read(space_id: Uuid) -> u64 {
    PEOPLE_READ
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .and_then(|counts| counts.get(&space_id).copied())
        .unwrap_or(0)
}

fn read_people(space_id: Uuid, count: usize) {
    #[cfg(test)]
    {
        let mut counts = PEOPLE_READ
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *counts
            .get_or_insert_with(HashMap::new)
            .entry(space_id)
            .or_default() += count as u64;
    }
    #[cfg(not(test))]
    let _ = (space_id, count);
}

#[derive(FromQueryResult)]
struct PersonRow {
    user_id: Uuid,
    standing: String,
    /// How many of the three system roles the space holds.
    system_roles: i64,
    /// An administrator by the old column, without the Administrator role in the new model.
    admin_unassigned: bool,
    role_id: Option<Uuid>,
    system_key: Option<String>,
    permissions: Option<Vec<String>>,
}

/// One row per (person, role they hold or their standing implies). An expired guest is no longer
/// in the space, and is not returned.
const PEOPLE: &str = concat!(
    "\
SELECT m.user_id, m.standing, r.id AS role_id, r.system_key, r.permissions, \
       (SELECT count(*) FROM space_roles s \
         WHERE s.space_id = m.space_id AND s.system_key IS NOT NULL) AS system_roles, \
       (m.role = 'admin' AND NOT EXISTS ( \
            SELECT 1 FROM space_role_assignments a JOIN space_roles s ON s.id = a.role_id \
             WHERE a.space_id = m.space_id AND a.user_id = m.user_id \
               AND s.system_key = 'administrator')) AS admin_unassigned \
  FROM space_members m \
  LEFT JOIN space_roles r ON r.space_id = m.space_id \
   AND (r.system_key = CASE WHEN m.standing = 'guest' THEN 'guests' ELSE 'members' END \
        OR EXISTS (SELECT 1 FROM space_role_holdings h \
                    WHERE h.role_id = r.id AND h.user_id = m.user_id)) \
 WHERE m.space_id = $1 AND ($2::uuid[] IS NULL OR m.user_id = ANY($2)) \
   AND ",
    super::membership::active_sql!()
);

/// The people of a space (or only `user`), keyed by id. Repairs a space whose system roles are
/// missing, then reads again.
pub(super) async fn people<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    user: Option<Uuid>,
) -> Result<BTreeMap<Uuid, Person>, DbErr> {
    people_where(db, space_id, user.map(|user| vec![user])).await
}

/// [`people`] restricted to some of them (a channel's members, say): who is not in the space is
/// left out.
pub(super) async fn people_among<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    users: &[Uuid],
) -> Result<BTreeMap<Uuid, Person>, DbErr> {
    if users.is_empty() {
        return Ok(BTreeMap::new());
    }
    people_where(db, space_id, Some(users.to_vec())).await
}

async fn people_where<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    users: Option<Vec<Uuid>>,
) -> Result<BTreeMap<Uuid, Person>, DbErr> {
    let users: sea_orm::Value = match users {
        Some(users) => users.into(),
        None => sea_orm::Value::Array(sea_orm::sea_query::ArrayType::Uuid, None),
    };
    let mut repaired = false;
    loop {
        issued(space_id);
        let rows = PersonRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            PEOPLE,
            [space_id.into(), users.clone()],
        ))
        .all(db)
        .await?;
        let mut people: BTreeMap<Uuid, Person> = BTreeMap::new();
        // The new model lost part of what the old columns say: a system role gone (a manual
        // delete, a partial restore), or an administrator without the Administrator role.
        let mut drifted = false;
        for row in rows {
            drifted |= row.system_roles < 3 || row.admin_unassigned;
            let standing = match row.standing.as_str() {
                "owner" => Standing::Owner,
                "member" => Standing::Member,
                // The CHECK allows nothing else; anything unexpected gets the narrowest standing.
                _ => Standing::Guest,
            };
            let person = people.entry(row.user_id).or_insert_with(|| Person {
                user_id: row.user_id,
                subject: Subject {
                    standing,
                    base: PermissionSet::EMPTY,
                    roles: Vec::new(),
                },
                base_role: None,
                groups: Vec::new(),
                role_groups: HashMap::new(),
                custom_roles: HashSet::new(),
                readable_audiences: HashSet::new(),
                ceiling: None,
            });
            let (Some(role_id), Some(names)) = (row.role_id, row.permissions) else {
                continue;
            };
            let permissions = PermissionSet::from_names(&names);
            match row.system_key.as_deref() {
                Some("members") | Some("guests") => {
                    person.base_role = Some(role_id);
                    person.subject.base = permissions;
                }
                key => {
                    if key.is_none() {
                        person.custom_roles.insert(role_id);
                    }
                    person.subject.roles.push((role_id, permissions));
                }
            }
        }
        read_people(space_id, people.len());
        let broken = drifted || people.values().any(|person| person.base_role.is_none());
        if !broken || repaired {
            attach_groups(db, space_id, &users, &mut people).await?;
            apply_preview(db, space_id, &mut people).await?;
            return Ok(people);
        }
        tracing::warn!(%space_id, "space without its system roles: deriving them again");
        issued(space_id);
        db.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT permissions_convert_space($1)",
            [space_id.into()],
        ))
        .await?;
        repaired = true;
    }
}

#[derive(FromQueryResult)]
struct PreviewedRole {
    system_key: Option<String>,
    permissions: Vec<String>,
}

/// While this request is a preview of `space_id`, the viewer stands as a member (a guest stays a
/// guest) holding the base role and the previewed role alone, no group; who they really are is kept
/// as the ceiling the preview never exceeds. Everyone else in the map, and every other space, is
/// left as it is. This is the one place a preview changes who somebody is.
async fn apply_preview<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    people: &mut BTreeMap<Uuid, Person>,
) -> Result<(), DbErr> {
    let Some(preview) = super::preview::of_space(space_id) else {
        return Ok(());
    };
    let Some(person) = people.get_mut(&preview.user_id) else {
        return Ok(());
    };
    // A role deleted meanwhile leaves the base role alone: less, never more.
    let role = PreviewedRole::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT system_key, permissions FROM space_roles WHERE id = $1 AND space_id = $2",
        [preview.role_id.into(), space_id.into()],
    ))
    .one(db)
    .await?;
    let real = person.subject.clone();
    let mut roles = Vec::new();
    let mut custom_roles = HashSet::new();
    if let Some(role) = role {
        roles.push((
            preview.role_id,
            PermissionSet::from_names(&role.permissions),
        ));
        if role.system_key.is_none() {
            custom_roles.insert(preview.role_id);
        }
    }
    person.ceiling = Some(Ceiling {
        subject: real.clone(),
        groups: std::mem::take(&mut person.groups),
        custom_roles: std::mem::replace(&mut person.custom_roles, custom_roles),
    });
    person.role_groups.clear();
    person.subject = Subject {
        standing: match real.standing {
            Standing::Guest => Standing::Guest,
            Standing::Owner | Standing::Member => Standing::Member,
        },
        base: real.base,
        roles,
    };
    Ok(())
}

#[derive(FromQueryResult)]
struct GroupRow {
    user_id: Uuid,
    group_id: Uuid,
    role_id: Option<Uuid>,
}

/// The groups of these people and the roles those groups carry, in one query whatever the count.
async fn attach_groups<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    users: &sea_orm::Value,
    people: &mut BTreeMap<Uuid, Person>,
) -> Result<(), DbErr> {
    if people.is_empty() {
        return Ok(());
    }
    issued(space_id);
    let rows = GroupRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT m.user_id, m.group_id, r.role_id \
           FROM space_group_members m \
           LEFT JOIN space_group_roles r ON r.group_id = m.group_id \
          WHERE m.space_id = $1 AND ($2::uuid[] IS NULL OR m.user_id = ANY($2))",
        [space_id.into(), users.clone()],
    ))
    .all(db)
    .await?;
    for row in rows {
        // Somebody the first query left out (an expired guest) has no groups here either.
        let Some(person) = people.get_mut(&row.user_id) else {
            continue;
        };
        if !person.groups.contains(&row.group_id) {
            person.groups.push(row.group_id);
        }
        if let Some(role) = row.role_id {
            let carriers = person.role_groups.entry(role).or_default();
            if !carriers.contains(&row.group_id) {
                carriers.push(row.group_id);
            }
        }
    }
    Ok(())
}

/// Each person of the space with their groups and the roles those carry (tests only).
#[cfg(test)]
pub async fn people_groups_for_test<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
) -> Result<HashMap<Uuid, (Vec<Uuid>, HashMap<Uuid, Vec<Uuid>>)>, DbErr> {
    Ok(people(db, space_id, None)
        .await?
        .into_iter()
        .map(|(id, person)| (id, (person.groups, person.role_groups)))
        .collect())
}

/// The rules stored on some channels, files or calendars of a space.
pub(super) async fn rules<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    column: permission_overrides::Column,
    ids: &[Uuid],
) -> Result<Vec<StoredRule>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    issued(space_id);
    Ok(permission_overrides::Entity::find()
        .filter(permission_overrides::Column::SpaceId.eq(space_id))
        .filter(column.is_in(ids.iter().copied()))
        .all(db)
        .await?
        .into_iter()
        .map(|row| StoredRule {
            channel_id: row.channel_id,
            file_id: row.file_id,
            calendar_id: row.calendar_id,
            role_id: row.role_id,
            user_id: row.user_id,
            group_id: row.group_id,
            audience_channel_id: row.audience_channel_id,
            allow: PermissionSet::from_names(&row.allow),
            deny: PermissionSet::from_names(&row.deny),
        })
        .collect())
}

/// Channels of the space among `ids` (another space's are left out).
pub(super) async fn channels_of<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    ids: &[Uuid],
) -> Result<Vec<channels::Model>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    issued(space_id);
    channels::Entity::find()
        .filter(channels::Column::SpaceId.eq(space_id))
        .filter(channels::Column::Id.is_in(ids.iter().copied()))
        .all(db)
        .await
}

/// Channel memberships among some channels, of one person or of everybody: (channel, person) to
/// channel role.
pub(super) async fn memberships<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    channel_ids: &[Uuid],
    user: Option<Uuid>,
) -> Result<HashMap<(Uuid, Uuid), String>, DbErr> {
    if channel_ids.is_empty() {
        return Ok(HashMap::new());
    }
    issued(space_id);
    let mut query = channel_members::Entity::find()
        .filter(channel_members::Column::ChannelId.is_in(channel_ids.iter().copied()));
    if let Some(user) = user {
        query = query.filter(channel_members::Column::UserId.eq(user));
    }
    Ok(query
        .all(db)
        .await?
        .into_iter()
        .map(|row| ((row.channel_id, row.user_id), row.role))
        .collect())
}

/// A space calendar of the space (a personal calendar, or another space's, is `None`).
pub(super) async fn calendar_of<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    calendar_id: Uuid,
) -> Result<Option<calendars::Model>, DbErr> {
    issued(space_id);
    calendars::Entity::find_by_id(calendar_id)
        .filter(calendars::Column::SpaceId.eq(space_id))
        .one(db)
        .await
}

/// Space calendars of the space among `ids` (personal ones and another space's are left out).
pub(super) async fn calendars_of<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    ids: &[Uuid],
) -> Result<Vec<calendars::Model>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    issued(space_id);
    calendars::Entity::find()
        .filter(calendars::Column::SpaceId.eq(space_id))
        .filter(calendars::Column::Id.is_in(ids.iter().copied()))
        .all(db)
        .await
}

/// A file and the folders above it, top first, the file last. Empty when the file is not in the
/// space.
#[derive(Clone, Debug, FromQueryResult)]
pub(super) struct FileRow {
    pub id: Uuid,
    pub owner_id: Option<Uuid>,
    pub conversation_id: Option<Uuid>,
    /// `file` or `folder`.
    pub kind: String,
}

const FILE_CHAIN: &str = "\
WITH RECURSIVE chain AS ( \
    SELECT id, parent_folder_id, space_id, owner_id, conversation_id, kind, 0 AS depth \
      FROM files WHERE id = $1 AND space_id = $2 \
  UNION ALL \
    SELECT f.id, f.parent_folder_id, f.space_id, f.owner_id, f.conversation_id, f.kind, \
           chain.depth + 1 \
      FROM files f JOIN chain ON f.id = chain.parent_folder_id \
     WHERE f.space_id = $2 AND chain.depth < 128 \
) SELECT id, space_id, owner_id, conversation_id, kind, depth FROM chain ORDER BY depth DESC";

pub(super) async fn file_chain<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    file_id: Uuid,
) -> Result<Vec<FileRow>, DbErr> {
    issued(space_id);
    FileRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        FILE_CHAIN,
        [file_id.into(), space_id.into()],
    ))
    .all(db)
    .await
}

#[derive(FromQueryResult)]
struct ChainRow {
    start: Uuid,
    id: Uuid,
    owner_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
    kind: String,
}

const FILE_CHAINS: &str = "\
WITH RECURSIVE chain AS ( \
    SELECT id AS start, id, parent_folder_id, owner_id, conversation_id, kind, 0 AS depth \
      FROM files WHERE id = ANY($1) AND space_id = $2 \
  UNION ALL \
    SELECT chain.start, f.id, f.parent_folder_id, f.owner_id, f.conversation_id, f.kind, \
           chain.depth + 1 \
      FROM files f JOIN chain ON f.id = chain.parent_folder_id \
     WHERE f.space_id = $2 AND chain.depth < 128 \
) SELECT start, id, owner_id, conversation_id, kind FROM chain ORDER BY start, depth DESC";

/// [`file_chain`] for many files at once, in one query: each file of the space among `ids` with its
/// folders, top first.
pub(super) async fn file_chains<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<FileRow>>, DbErr> {
    let mut chains: HashMap<Uuid, Vec<FileRow>> = HashMap::new();
    if ids.is_empty() {
        return Ok(chains);
    }
    issued(space_id);
    let rows = ChainRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        FILE_CHAINS,
        [ids.to_vec().into(), space_id.into()],
    ))
    .all(db)
    .await?;
    for row in rows {
        chains.entry(row.start).or_default().push(FileRow {
            id: row.id,
            owner_id: row.owner_id,
            conversation_id: row.conversation_id,
            kind: row.kind,
        });
    }
    Ok(chains)
}

/// The kind (`channel`, `direct`) of each conversation of the space among `ids`.
pub(super) async fn conversation_kinds<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    ids: &[Uuid],
) -> Result<HashMap<Uuid, String>, DbErr> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    issued(space_id);
    Ok(conversations::Entity::find()
        .filter(conversations::Column::SpaceId.eq(space_id))
        .filter(conversations::Column::Id.is_in(ids.iter().copied()))
        .all(db)
        .await?
        .into_iter()
        .map(|conversation| (conversation.id, conversation.kind))
        .collect())
}

/// The direct messages among `ids` that `user` takes part in.
pub(super) async fn dm_participation<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    user: Uuid,
    ids: &[Uuid],
) -> Result<HashSet<Uuid>, DbErr> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    issued(space_id);
    Ok(dm_participants::Entity::find()
        .filter(dm_participants::Column::UserId.eq(user))
        .filter(dm_participants::Column::DmId.is_in(ids.iter().copied()))
        .all(db)
        .await?
        .into_iter()
        .map(|participant| participant.dm_id)
        .collect())
}

#[derive(FromQueryResult)]
struct PostedRow {
    file_id: Uuid,
    conversation_id: Uuid,
}

/// The conversations of the space each of `file_ids` was posted in (attached to a message there),
/// as (file, conversation).
pub(super) async fn posted_in<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    file_ids: &[Uuid],
) -> Result<Vec<(Uuid, Uuid)>, DbErr> {
    if file_ids.is_empty() {
        return Ok(Vec::new());
    }
    issued(space_id);
    Ok(PostedRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT DISTINCT a.file_id, m.conversation_id \
           FROM message_attachments a \
           JOIN messages m ON m.id = a.message_id \
           JOIN conversations c ON c.id = m.conversation_id \
          WHERE a.file_id = ANY($1) AND c.space_id = $2",
        [file_ids.to_vec().into(), space_id.into()],
    ))
    .all(db)
    .await?
    .into_iter()
    .map(|row| (row.file_id, row.conversation_id))
    .collect())
}

/// What a channel role adds inside its channel: running it.
const CHANNEL_MODERATION: PermissionSet = PermissionSet::of(&[
    Permission::ChannelManage,
    Permission::ChannelMembersManage,
    Permission::MessageManage,
]);

/// The level and facts of a channel for one person: its rules, their channel role as a personal
/// rule, whether they joined it.
pub(super) fn channel_level(
    person: &Person,
    channel: &channels::Model,
    rules: &[StoredRule],
    memberships: &HashMap<(Uuid, Uuid), String>,
) -> (Level, Facts) {
    let role = memberships.get(&(channel.id, person.user_id));
    let moderation = match role.map(String::as_str) {
        Some("owner") => Some("owner"),
        Some("admin") => Some("admin"),
        _ => None,
    }
    .map(|role| Rule {
        target: TargetRef::User,
        allow: CHANNEL_MODERATION,
        deny: PermissionSet::EMPTY,
        source: Source::ChannelRole(role),
        lifts_lock: false,
        whom: Whom::Both,
    });
    let level = Level {
        kind: LevelKind::Channel,
        id: channel.id,
        rules: person.rules(
            rules
                .iter()
                .filter(|rule| rule.channel_id == Some(channel.id)),
            moderation,
        ),
    };
    let facts = Facts {
        private_channel: channel.channel_type == "private",
        joined: role.is_some(),
        archived: channel.channel_type == "archived",
        author: false,
    };
    (level, facts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(base: Uuid, group: Uuid, custom: Uuid, system: Uuid, audience: Uuid) -> Person {
        Person {
            user_id: Uuid::new_v4(),
            subject: Subject {
                standing: Standing::Member,
                base: PermissionSet::EMPTY,
                roles: vec![
                    (custom, PermissionSet::EMPTY),
                    (system, PermissionSet::EMPTY),
                ],
            },
            base_role: Some(base),
            groups: vec![group],
            role_groups: HashMap::new(),
            readable_audiences: HashSet::from([audience]),
            custom_roles: HashSet::from([custom]),
            ceiling: None,
        }
    }

    fn aimed(f: impl FnOnce(&mut StoredRule)) -> StoredRule {
        let mut rule = StoredRule {
            channel_id: Some(Uuid::new_v4()),
            file_id: None,
            calendar_id: None,
            role_id: None,
            user_id: None,
            group_id: None,
            audience_channel_id: None,
            allow: PermissionSet::of(&[crate::permissions::catalogue::Permission::ChannelView]),
            deny: PermissionSet::EMPTY,
        };
        f(&mut rule);
        rule
    }

    /// Only a group, a person or a custom role opens a private channel: never a base role, the
    /// Administrator (a system role) or the readers of a channel.
    #[test]
    fn lifts_lock_is_never_true_on_a_base_role_a_system_role_or_an_audience() {
        let (base, group, custom, system, audience) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let who = person(base, group, custom, system, audience);
        let stored = [
            aimed(|r| r.role_id = Some(base)),
            aimed(|r| r.role_id = Some(system)),
            aimed(|r| r.audience_channel_id = Some(audience)),
            aimed(|r| r.role_id = Some(custom)),
            aimed(|r| r.group_id = Some(group)),
            aimed(|r| r.user_id = Some(who.user_id)),
        ];
        let rules = who.rules(stored.iter(), None);
        let lifts: Vec<(TargetRef, bool)> =
            rules.iter().map(|r| (r.target, r.lifts_lock)).collect();
        assert_eq!(
            lifts,
            [
                (TargetRef::BaseRole, false),
                (TargetRef::Role(system), false),
                (TargetRef::Audience(audience), false),
                (TargetRef::Role(custom), true),
                (TargetRef::Group(group), true),
                (TargetRef::User, true),
            ]
        );
    }
}
