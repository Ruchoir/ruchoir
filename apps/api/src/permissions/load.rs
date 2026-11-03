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

use std::collections::{BTreeMap, HashMap};

use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, DbErr, EntityTrait, FromQueryResult,
    QueryFilter, Statement,
};
use uuid::Uuid;

use super::catalogue::{Permission, PermissionSet};
use super::engine::{Facts, Level, LevelKind, Rule, Source, Standing, Subject, TargetRef};
use crate::entities::{calendars, channel_members, channels, permission_overrides};

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
}

/// A rule as stored, before it is matched to a person.
#[derive(Clone, Debug)]
pub(super) struct StoredRule {
    pub channel_id: Option<Uuid>,
    pub file_id: Option<Uuid>,
    pub calendar_id: Option<Uuid>,
    pub role_id: Option<Uuid>,
    pub user_id: Option<Uuid>,
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
        let mut rules: Vec<Rule> = first.into_iter().collect();
        for rule in stored {
            let target = match (rule.role_id, rule.user_id) {
                (Some(role), _) if Some(role) == self.base_role => TargetRef::BaseRole,
                (Some(role), _) if self.subject.roles.iter().any(|(held, _)| *held == role) => {
                    TargetRef::Role(role)
                }
                (None, Some(user)) if user == self.user_id => TargetRef::User,
                _ => continue,
            };
            let source = match target {
                TargetRef::BaseRole => Source::BaseRole,
                TargetRef::Role(role) => Source::Role(role),
                TargetRef::User => Source::User,
            };
            rules.push(Rule {
                target,
                allow: rule.allow,
                deny: rule.deny,
                source,
            });
        }
        rules
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

#[derive(FromQueryResult)]
struct PersonRow {
    user_id: Uuid,
    standing: String,
    role_id: Option<Uuid>,
    system_key: Option<String>,
    permissions: Option<Vec<String>>,
}

/// One row per (person, role they hold or their standing implies). An expired guest is no longer
/// in the space, and is not returned.
const PEOPLE: &str = "\
SELECT m.user_id, m.standing, r.id AS role_id, r.system_key, r.permissions \
  FROM space_members m \
  LEFT JOIN space_roles r ON r.space_id = m.space_id \
   AND (r.system_key = CASE WHEN m.standing = 'guest' THEN 'guests' ELSE 'members' END \
        OR EXISTS (SELECT 1 FROM space_role_assignments a \
                    WHERE a.role_id = r.id AND a.user_id = m.user_id)) \
 WHERE m.space_id = $1 AND ($2::uuid IS NULL OR m.user_id = $2) \
   AND (m.expires_at IS NULL OR m.expires_at > now())";

/// The people of a space (or only `user`), keyed by id. Repairs a space whose system roles are
/// missing, then reads again.
pub(super) async fn people<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    user: Option<Uuid>,
) -> Result<BTreeMap<Uuid, Person>, DbErr> {
    let mut repaired = false;
    loop {
        issued(space_id);
        let rows = PersonRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            PEOPLE,
            [space_id.into(), user.into()],
        ))
        .all(db)
        .await?;
        let mut people: BTreeMap<Uuid, Person> = BTreeMap::new();
        for row in rows {
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
                _ => person.subject.roles.push((role_id, permissions)),
            }
        }
        let broken = people.values().any(|person| person.base_role.is_none());
        if !broken || repaired {
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
