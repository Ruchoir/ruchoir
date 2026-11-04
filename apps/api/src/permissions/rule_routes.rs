//! The rule routes the Access and Share dialogs call (permissions lot 4): read who has what on a
//! channel, a file or folder, or a calendar, set a preset level for someone, remove a line.
//!
//! Free in every edition: the preset levels, for "everyone", the Administrator, a group, a person
//! or the readers of a channel. What is paid (a custom role as a target, a rule matching no preset)
//! is refused by [`ensure_writable`], the same function the dialog's `may` block is drawn from, so
//! the screen and the server cannot disagree.
//!
//! Every write is one transaction: the resource's row is locked and the stored rule re-read, the
//! change is decided on what was read, written together with its log entry, and the space is told
//! afterwards. A request that changes nothing writes nothing and says nothing.
//!
//! The view of a channel and the write bit of a calendar belong to the legacy settings
//! (`channel_role_access`, `write_access`) for the system roles: the rules of "Tout l'espace" and
//! the Administrator are derived from them by the database. Those two bits are therefore written
//! through the legacy settings, and only the rest of the level is stored as a rule.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, put};
use axum::{Json, Router};
use sea_orm::{ConnectionTrait, DbBackend, DbErr, EntityTrait, Statement, TransactionTrait};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::catalogue::{Permission, PermissionSet};
use super::check::{self, Resource};
use super::delegation::rank_of;
use super::engine::Standing;
use super::groups::Paid;
use super::levels::{
    level_sets, nearest_level, read_system_rule, rule_sets, summary, Kind, Level, LevelError,
    LevelRead, SystemRole as Sys, Target, TriState,
};
use super::load;
use super::rules::{
    current_rule, delete_rule, describe, editor_of, ensure_writable, level_name, lock_resource,
    log_rule, write_rule, Aim, Editor, EditorKind, Existing, ResourceRef, RuleSubject, Shown,
    TargetRef,
};
use super::system_roles::GUEST_CEILING;
use crate::audit::Action;
use crate::auth::extract::AuthSession;
use crate::messaging::error::ApiError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/spaces/{space_id}/access/{kind}/{resource_id}",
            get(read_access),
        )
        .route(
            "/api/v1/spaces/{space_id}/access/{kind}/{resource_id}/entries",
            put(put_entry),
        )
        .route(
            "/api/v1/spaces/{space_id}/access/{kind}/{resource_id}/entries/{rule_id}",
            delete(delete_entry),
        )
}

/// A thing of the space, named: the folder an entry is inherited from, a file's parent.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct NamedRefDto {
    /// `file` (a folder is a file) for now.
    pub kind: &'static str,
    /// Absent when the viewer cannot open that folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// A folder the viewer cannot open: no id, no name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
}

/// The resource the dialog is about.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AccessResourceDto {
    /// `channel`, `file` or `calendar`.
    pub kind: &'static str,
    pub id: Uuid,
    pub name: String,
    /// The folder a file or folder sits in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<NamedRefDto>,
}

/// Whom an entry is about.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AccessTargetDto {
    /// `everyone` (`@members` or `@guests`, by `id`), `role` (the Administrator or a custom role),
    /// `group`, `user`, or `audience` (whoever reads a channel; files only).
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// An audience whose channel the viewer cannot see: no id, no name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
}

/// How a custom entry differs from its nearest level.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AccessSummaryDto {
    /// The preset level it is nearest to.
    pub nearest: &'static str,
    /// Each permission that differs, as `allow` (added), `deny` or `unset` (the level grants it,
    /// the entry does not).
    pub changes: Vec<AccessChangeDto>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AccessChangeDto {
    pub permission: &'static str,
    pub state: &'static str,
}

/// One line of the dialog.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EntryDto {
    /// The rule behind it; null for an inherited line and for what the base roles grant.
    pub id: Option<Uuid>,
    pub target: AccessTargetDto,
    /// `none`, `read`, `contribute`, `manage`, or `custom` (a rule that matches no preset).
    pub level: &'static str,
    pub allow: Vec<&'static str>,
    pub deny: Vec<&'static str>,
    /// For a `custom` entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<AccessSummaryDto>,
    /// The folder a file's inherited line comes from; never editable here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inherited_from: Option<NamedRefDto>,
    /// A group holding guests whose level reaches what a guest can never hold: its guests get less.
    pub clamped: bool,
    /// The target is a guest.
    pub guest: bool,
    /// The view of a channel or the write bit of a calendar is the legacy setting of the system
    /// role (`allowed_roles`, `write_access`).
    pub via_legacy: bool,
}

/// What the caller may do in this dialog, each flag drawn from [`ensure_writable`]'s own rules.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AccessMayDto {
    /// Edit the levels.
    pub edit: bool,
    /// Write rules that match no preset, and name custom roles (enterprise edition).
    pub fine: bool,
    /// Why `edit` is false: `licence_required`, `licence_frozen`, or `not_allowed`.
    pub reason: Option<&'static str>,
    /// The levels the caller may give here (`none` only to those who may reserve).
    pub manage_target_levels: Vec<&'static str>,
}

/// Who has what on a channel, a file or folder, or a calendar.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AccessDto {
    pub resource: AccessResourceDto,
    /// A private channel.
    pub private: bool,
    pub entries: Vec<EntryDto>,
    pub may: AccessMayDto,
    /// An archived channel, or a trashed file.
    pub archived: bool,
}

fn resource_of(kind: &str, id: Uuid) -> Result<ResourceRef, ApiError> {
    match kind {
        "channel" => Ok(ResourceRef::Channel(id)),
        "file" => Ok(ResourceRef::File(id)),
        "calendar" => Ok(ResourceRef::Calendar(id)),
        _ => Err(ApiError::NotFound),
    }
}

fn kind_word(resource: ResourceRef) -> &'static str {
    match resource {
        ResourceRef::Channel(_) => "channel",
        ResourceRef::File(_) => "file",
        ResourceRef::Calendar(_) => "calendar",
    }
}

/// Whether the legacy settings own a bit of this system role's rule on this kind of resource: the
/// view of a channel for all three, the write bit of a calendar for members and Administrator.
fn legacy_bit(kind: Kind, sys: Sys) -> Option<Permission> {
    match (kind, sys) {
        (Kind::Channel, _) => Some(Permission::ChannelView),
        (Kind::Calendar, Sys::Members | Sys::Administrator) => Some(Permission::CalendarWrite),
        _ => None,
    }
}

/// The highest level a base role's permissions already cover.
fn derived_level(kind: Kind, base: PermissionSet) -> Level {
    [Level::Manage, Level::Contribute, Level::Read]
        .into_iter()
        .find(|&l| level_sets(kind, l).minus(base).is_empty())
        .unwrap_or(Level::None)
}

fn names(set: PermissionSet) -> Vec<&'static str> {
    set.iter().map(Permission::name).collect()
}

// -- reading ------------------------------------------------------------------------------------

struct StoredRow {
    id: Uuid,
    node: Uuid,
    role_id: Option<Uuid>,
    user_id: Option<Uuid>,
    group_id: Option<Uuid>,
    audience_id: Option<Uuid>,
    allow: PermissionSet,
    deny: PermissionSet,
    system_key: Option<String>,
    role_name: Option<String>,
    group_name: Option<String>,
    user_name: Option<String>,
    user_standing: Option<String>,
    channel_name: Option<String>,
    group_has_guests: bool,
}

async fn rows_on(
    db: &impl ConnectionTrait,
    space_id: Uuid,
    resource: ResourceRef,
    nodes: &[Uuid],
) -> Result<Vec<StoredRow>, DbErr> {
    let sql = format!(
        "SELECT o.id, o.{col} AS node, o.role_id, o.user_id, o.group_id, \
                o.audience_channel_id, o.allow, o.deny, \
                r.system_key, r.name::text AS role_name, g.name::text AS group_name, \
                u.display_name AS user_name, m.standing AS user_standing, \
                c.name::text AS channel_name, \
                EXISTS (SELECT 1 FROM space_group_members gm \
                          JOIN space_members sm ON sm.space_id = gm.space_id AND sm.user_id = gm.user_id \
                         WHERE gm.group_id = o.group_id AND sm.standing = 'guest') AS group_has_guests \
           FROM permission_overrides o \
           LEFT JOIN space_roles r ON r.id = o.role_id \
           LEFT JOIN space_groups g ON g.id = o.group_id \
           LEFT JOIN users u ON u.id = o.user_id \
           LEFT JOIN space_members m ON m.space_id = o.space_id AND m.user_id = o.user_id \
           LEFT JOIN channels c ON c.id = o.audience_channel_id \
          WHERE o.space_id = $1 AND o.{col} = ANY($2) \
          ORDER BY o.created_at, o.id",
        col = resource.column()
    );
    let mut rows = Vec::new();
    for row in db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            [space_id.into(), nodes.to_vec().into()],
        ))
        .await?
    {
        let allow: Vec<String> = row.try_get("", "allow")?;
        let deny: Vec<String> = row.try_get("", "deny")?;
        rows.push(StoredRow {
            id: row.try_get("", "id")?,
            node: row.try_get("", "node")?,
            role_id: row.try_get("", "role_id")?,
            user_id: row.try_get("", "user_id")?,
            group_id: row.try_get("", "group_id")?,
            audience_id: row.try_get("", "audience_channel_id")?,
            allow: PermissionSet::from_names(&allow),
            deny: PermissionSet::from_names(&deny),
            system_key: row.try_get("", "system_key")?,
            role_name: row.try_get("", "role_name")?,
            group_name: row.try_get("", "group_name")?,
            user_name: row.try_get("", "user_name")?,
            user_standing: row.try_get("", "user_standing")?,
            channel_name: row.try_get("", "channel_name")?,
            group_has_guests: row.try_get("", "group_has_guests")?,
        });
    }
    Ok(rows)
}

/// Who a line covers, for filtering what a guest may see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cover {
    Everyone(Uuid),
    Administrator,
    Role(Uuid),
    User(Uuid),
    Group(Uuid),
    Audience { visible: bool },
}

struct Line {
    dto: EntryDto,
    cover: Cover,
    /// Sorting: everyone, roles, groups, people, audiences.
    rank: u8,
}

fn change_word(state: TriState) -> &'static str {
    match state {
        TriState::Allow => "allow",
        TriState::Deny => "deny",
        TriState::Unset => "unset",
    }
}

/// The line of one stored rule, or `None` when it holds nothing the dialog shows (a rule of a
/// system role that only carries what the legacy settings own).
async fn line_of(
    state: &AppState,
    space_id: Uuid,
    viewer: Uuid,
    kind: Kind,
    row: &StoredRow,
    inherited_from: Option<NamedRefDto>,
) -> Result<Option<Line>, ApiError> {
    let editable = inherited_from.is_none();
    let (target_kind, id, name, class, cover, sys, rank): (
        &'static str,
        Option<Uuid>,
        Option<String>,
        Target,
        Cover,
        Option<Sys>,
        u8,
    ) = if let Some(role) = row.role_id {
        let sys = Sys::of(row.system_key.as_deref());
        match sys {
            Some(Sys::Members | Sys::Guests) => (
                "everyone",
                Some(role),
                row.role_name.clone(),
                Target::Everyone,
                Cover::Everyone(role),
                sys,
                0,
            ),
            Some(Sys::Administrator) => (
                "role",
                Some(role),
                row.role_name.clone(),
                Target::Role { system: true },
                Cover::Administrator,
                sys,
                1,
            ),
            None => (
                "role",
                Some(role),
                row.role_name.clone(),
                Target::Role { system: false },
                Cover::Role(role),
                None,
                2,
            ),
        }
    } else if let Some(group) = row.group_id {
        (
            "group",
            Some(group),
            row.group_name.clone(),
            Target::Group,
            Cover::Group(group),
            None,
            3,
        )
    } else if let Some(user) = row.user_id {
        (
            "user",
            Some(user),
            row.user_name.clone(),
            Target::User,
            Cover::User(user),
            None,
            4,
        )
    } else if let Some(channel) = row.audience_id {
        let visible = check::can(
            &state.db,
            space_id,
            viewer,
            Resource::Channel(channel),
            Permission::ChannelView,
        )
        .await?;
        let (id, name) = if visible {
            (Some(channel), row.channel_name.clone())
        } else {
            (None, None)
        };
        (
            "audience",
            id,
            name,
            Target::Audience,
            Cover::Audience { visible },
            None,
            5,
        )
    } else {
        return Ok(None);
    };

    let read = read_system_rule(kind, class, sys, row.allow, row.deny);
    let (level, shown_summary) = match read {
        LevelRead::NoRule => return Ok(None),
        LevelRead::Level(level) => (level_name(level), None),
        LevelRead::Custom => (
            "custom",
            Some(AccessSummaryDto {
                nearest: level_name(nearest_level(kind, row.allow)),
                changes: summary(kind, row.allow, row.deny)
                    .into_iter()
                    .map(|(permission, state)| AccessChangeDto {
                        permission: permission.name(),
                        state: change_word(state),
                    })
                    .collect(),
            }),
        ),
    };
    let hidden = matches!(cover, Cover::Audience { visible: false });
    let guest = sys == Some(Sys::Guests) || row.user_standing.as_deref() == Some("guest");
    Ok(Some(Line {
        dto: EntryDto {
            id: editable.then_some(row.id),
            target: AccessTargetDto {
                kind: target_kind,
                id,
                name,
                hidden: hidden.then_some(true),
            },
            level,
            allow: names(row.allow),
            deny: names(row.deny),
            summary: shown_summary,
            inherited_from,
            clamped: class == Target::Group
                && row.group_has_guests
                && !row.allow.intersect(GUEST_CEILING).is_empty(),
            guest,
            via_legacy: sys.is_some_and(|s| legacy_bit(kind, s).is_some()),
        },
        cover,
        rank,
    }))
}

struct Header {
    name: String,
    private: bool,
    archived: bool,
}

async fn header(
    db: &impl ConnectionTrait,
    space_id: Uuid,
    resource: ResourceRef,
) -> Result<Header, ApiError> {
    let sql = match resource {
        ResourceRef::Channel(_) => {
            "SELECT name::text AS name, type = 'private' AS private, \
                    type = 'archived' AS archived FROM channels WHERE id = $1 AND space_id = $2"
        }
        ResourceRef::File(_) => {
            "SELECT name::text AS name, false AS private, deleted_at IS NOT NULL AS archived \
               FROM files WHERE id = $1 AND space_id = $2"
        }
        ResourceRef::Calendar(_) => {
            "SELECT name::text AS name, false AS private, false AS archived \
               FROM calendars WHERE id = $1 AND space_id = $2"
        }
    };
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            [resource.id().into(), space_id.into()],
        ))
        .await?
        .ok_or(ApiError::Forbidden)?;
    Ok(Header {
        name: row.try_get("", "name")?,
        private: row.try_get("", "private")?,
        archived: row.try_get("", "archived")?,
    })
}

/// A file and the folders above it, nearest first, with their names.
async fn chain_of(
    db: &impl ConnectionTrait,
    space_id: Uuid,
    file_id: Uuid,
) -> Result<Vec<(Uuid, String)>, DbErr> {
    let ids: Vec<Uuid> = load::file_chain(db, space_id, file_id)
        .await?
        .into_iter()
        .rev()
        .map(|row| row.id)
        .collect();
    let mut names: HashMap<Uuid, String> = HashMap::new();
    for row in db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id, name FROM files WHERE space_id = $1 AND id = ANY($2)",
            [space_id.into(), ids.clone().into()],
        ))
        .await?
    {
        names.insert(row.try_get("", "id")?, row.try_get("", "name")?);
    }
    Ok(ids
        .into_iter()
        .map(|id| {
            let name = names.remove(&id).unwrap_or_default();
            (id, name)
        })
        .collect())
}

/// The permissions a system role holds on its own.
async fn base_of(
    db: &impl ConnectionTrait,
    space_id: Uuid,
) -> Result<Vec<(Uuid, Sys, String, PermissionSet)>, DbErr> {
    let mut bases = Vec::new();
    for row in db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id, system_key, name::text AS name, permissions FROM space_roles \
              WHERE space_id = $1 AND system_key IS NOT NULL",
            [space_id.into()],
        ))
        .await?
    {
        let key: String = row.try_get("", "system_key")?;
        let permissions: Vec<String> = row.try_get("", "permissions")?;
        if let Some(sys) = Sys::of(Some(&key)) {
            bases.push((
                row.try_get("", "id")?,
                sys,
                row.try_get("", "name")?,
                PermissionSet::from_names(&permissions),
            ));
        }
    }
    Ok(bases)
}

fn may_of(editor: Option<&Editor>, resource: ResourceRef) -> AccessMayDto {
    let Some(editor) = editor else {
        return AccessMayDto {
            edit: false,
            fine: false,
            reason: Some("not_allowed"),
            manage_target_levels: Vec::new(),
        };
    };
    let reason = match (editor.kind, editor.paid) {
        (EditorKind::Local, Paid::Frozen) => Some("licence_frozen"),
        (EditorKind::Local, Paid::Community) => Some("licence_required"),
        _ => None,
    };
    if reason.is_some() {
        return AccessMayDto {
            edit: false,
            fine: false,
            reason,
            manage_target_levels: Vec::new(),
        };
    }
    let strong = matches!(editor.kind, EditorKind::Owner | EditorKind::Space);
    let kind = resource.kind();
    let mut levels = Vec::new();
    if strong {
        levels.push(level_name(Level::None));
    }
    for level in [Level::Read, Level::Contribute, Level::Manage] {
        if level_sets(kind, level).minus(editor.rights).is_empty() {
            levels.push(level_name(level));
        }
    }
    AccessMayDto {
        edit: true,
        fine: editor.paid == Paid::Enterprise,
        reason: None,
        manage_target_levels: levels,
    }
}

/// The dialog of `resource` as `viewer` reads it.
async fn access_dto(
    state: &AppState,
    space_id: Uuid,
    viewer: Uuid,
    resource: ResourceRef,
    editor: Option<&Editor>,
) -> Result<AccessDto, ApiError> {
    let db = &state.db;
    let kind = resource.kind();
    let head = header(db, space_id, resource).await?;
    // The resource and the folders above it, nearest first.
    let nodes: Vec<(Uuid, String)> = match resource {
        ResourceRef::File(id) => chain_of(db, space_id, id).await?,
        _ => vec![(resource.id(), head.name.clone())],
    };
    // The folders above, named only to a viewer who can open them.
    let mut folders: HashMap<Uuid, NamedRefDto> = HashMap::new();
    for (id, name) in nodes.iter().skip(1) {
        let opens = check::can(
            db,
            space_id,
            viewer,
            Resource::File(*id),
            Permission::FilesView,
        )
        .await?;
        folders.insert(
            *id,
            if opens {
                NamedRefDto {
                    kind: "file",
                    id: Some(*id),
                    name: Some(name.clone()),
                    hidden: None,
                }
            } else {
                NamedRefDto {
                    kind: "file",
                    id: None,
                    name: None,
                    hidden: Some(true),
                }
            },
        );
    }
    let parent = nodes.get(1).and_then(|(id, _)| folders.get(id).cloned());
    let ids: Vec<Uuid> = nodes.iter().map(|(id, _)| *id).collect();
    let stored = rows_on(db, space_id, resource, &ids).await?;

    // Closest wins: a target already read on a nearer item hides the same target further up.
    let mut seen: HashSet<(u8, Uuid)> = HashSet::new();
    let mut lines: Vec<Line> = Vec::new();
    for (depth, (node, _)) in nodes.iter().enumerate() {
        for row in stored.iter().filter(|row| row.node == *node) {
            let key = if let Some(id) = row.role_id {
                (0, id)
            } else if let Some(id) = row.user_id {
                (1, id)
            } else if let Some(id) = row.group_id {
                (2, id)
            } else if let Some(id) = row.audience_id {
                (3, id)
            } else {
                continue;
            };
            if seen.contains(&key) {
                continue;
            }
            let inherited = if depth > 0 {
                folders.get(node).cloned()
            } else {
                None
            };
            if let Some(line) = line_of(state, space_id, viewer, kind, row, inherited).await? {
                seen.insert(key);
                lines.push(line);
            }
        }
    }
    // The base roles speak for everyone and the Administrator where no rule does.
    for (role, sys, name, permissions) in base_of(db, space_id).await? {
        if sys == Sys::Guests || seen.contains(&(0, role)) {
            continue;
        }
        let (target_kind, cover, rank) = match sys {
            Sys::Members => ("everyone", Cover::Everyone(role), 0),
            _ => ("role", Cover::Administrator, 1),
        };
        lines.push(Line {
            dto: EntryDto {
                id: None,
                target: AccessTargetDto {
                    kind: target_kind,
                    id: Some(role),
                    name: Some(name),
                    hidden: None,
                },
                level: level_name(derived_level(kind, permissions)),
                allow: Vec::new(),
                deny: Vec::new(),
                summary: None,
                inherited_from: None,
                clamped: false,
                guest: false,
                via_legacy: legacy_bit(kind, sys).is_some(),
            },
            cover,
            rank,
        });
    }

    // A guest sees what covers them: themselves, their groups, the guests line, what they hold.
    let people = load::people(db, space_id, Some(viewer)).await?;
    if let Some(person) = people
        .get(&viewer)
        .filter(|p| p.subject.standing == Standing::Guest)
    {
        lines.retain(|line| match line.cover {
            Cover::Everyone(role) => Some(role) == person.base_role,
            Cover::Administrator => false,
            Cover::Role(role) => person.subject.roles.iter().any(|(held, _)| *held == role),
            Cover::User(user) => user == viewer,
            Cover::Group(group) => person.groups.contains(&group),
            Cover::Audience { visible } => visible,
        });
    }
    lines.sort_by(|a, b| {
        (
            a.dto.inherited_from.is_some(),
            a.rank,
            a.dto.target.name.as_deref().map(str::to_lowercase),
        )
            .cmp(&(
                b.dto.inherited_from.is_some(),
                b.rank,
                b.dto.target.name.as_deref().map(str::to_lowercase),
            ))
    });

    Ok(AccessDto {
        resource: AccessResourceDto {
            kind: kind_word(resource),
            id: resource.id(),
            name: head.name,
            parent,
        },
        private: head.private,
        entries: lines.into_iter().map(|line| line.dto).collect(),
        may: may_of(editor, resource),
        archived: head.archived,
    })
}

/// Whether `user` may open the resource (the dialog's own door, with the editors).
async fn can_open(
    state: &AppState,
    space_id: Uuid,
    user: Uuid,
    resource: ResourceRef,
) -> Result<bool, ApiError> {
    Ok(check::can(
        &state.db,
        space_id,
        user,
        resource.engine(),
        resource.view(),
    )
    .await?)
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/access/{kind}/{resource_id}",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("kind" = String, Path, description = "`channel`, `file` (or a folder) or `calendar`"),
        ("resource_id" = Uuid, Path, description = "The channel, file, folder or calendar")
    ),
    responses(
        (status = 200, description = "Who has what here, and what the caller may do about it", body = AccessDto),
        (status = 403, description = "The caller cannot open this resource"),
        (status = 404, description = "Not a kind of resource")
    )
)]
pub async fn read_access(
    State(state): State<AppState>,
    session: AuthSession,
    Path((space_id, kind, resource_id)): Path<(Uuid, String, Uuid)>,
) -> Result<Json<AccessDto>, ApiError> {
    let resource = resource_of(&kind, resource_id)?;
    let editor = editor_of(&state, space_id, session.user_id, resource).await?;
    if editor.is_none() && !can_open(&state, space_id, session.user_id, resource).await? {
        return Err(ApiError::Forbidden);
    }
    Ok(Json(
        access_dto(&state, space_id, session.user_id, resource, editor.as_ref()).await?,
    ))
}

// -- writing ------------------------------------------------------------------------------------

/// Whom a new entry is aimed at.
#[derive(Debug, Deserialize, ToSchema)]
pub struct AccessTargetRequest {
    /// `everyone`, `role`, `group`, `user` or `audience`.
    pub kind: String,
    /// Required but for `everyone`, where it names `@guests` (absent: `@members`).
    pub id: Option<Uuid>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PutEntryRequest {
    pub target: AccessTargetRequest,
    /// `none` (for everyone; a fine rule for anyone else), `read`, `contribute` or `manage`.
    pub level: String,
}

fn parse_level(word: &str) -> Result<Level, ApiError> {
    match word {
        "none" => Ok(Level::None),
        "read" => Ok(Level::Read),
        "contribute" => Ok(Level::Contribute),
        "manage" => Ok(Level::Manage),
        _ => Err(ApiError::BadRequest(
            "a level is none, read, contribute or manage",
        )),
    }
}

/// Whom a rule is aimed at, before it is looked up.
#[derive(Debug, Clone, Copy)]
enum Pick {
    Everyone(Option<Uuid>),
    Role(Uuid),
    Group(Uuid),
    User(Uuid),
    Audience(Uuid),
}

fn pick_of(target: &AccessTargetRequest) -> Result<Pick, ApiError> {
    let need = || {
        target
            .id
            .ok_or(ApiError::BadRequest("this target needs an id"))
    };
    match target.kind.as_str() {
        "everyone" => Ok(Pick::Everyone(target.id)),
        "role" => Ok(Pick::Role(need()?)),
        "group" => Ok(Pick::Group(need()?)),
        "user" => Ok(Pick::User(need()?)),
        "audience" => Ok(Pick::Audience(need()?)),
        _ => Err(ApiError::BadRequest(
            "a target is everyone, role, group, user or audience",
        )),
    }
}

/// A target as the checks and the writes need it.
struct Resolved {
    subject: RuleSubject,
    tref: TargetRef,
    sys: Option<Sys>,
}

struct RoleFacts {
    id: Uuid,
    sys: Option<Sys>,
    position: i32,
}

async fn role_facts(
    db: &impl ConnectionTrait,
    space_id: Uuid,
    role: Option<Uuid>,
    key: Option<&str>,
) -> Result<Option<RoleFacts>, DbErr> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id, system_key, position FROM space_roles \
              WHERE space_id = $1 AND ($2::uuid IS NULL OR id = $2) \
                AND ($3::text IS NULL OR system_key = $3)",
            [space_id.into(), role.into(), key.map(str::to_owned).into()],
        ))
        .await?;
    let Some(row) = row else { return Ok(None) };
    let key: Option<String> = row.try_get("", "system_key")?;
    Ok(Some(RoleFacts {
        id: row.try_get("", "id")?,
        sys: Sys::of(key.as_deref()),
        position: row.try_get("", "position")?,
    }))
}

async fn exists(
    db: &impl ConnectionTrait,
    sql: &str,
    values: Vec<sea_orm::Value>,
) -> Result<bool, DbErr> {
    Ok(db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            values,
        ))
        .await?
        .is_some())
}

/// Look the target up in the space and gather what [`ensure_writable`] needs to know about it
/// relative to the editor. A target that is not the space's is answered, not refused here: the
/// decision refuses it in its own order.
async fn resolve(
    state: &AppState,
    txn: &impl ConnectionTrait,
    space_id: Uuid,
    editor_user: Uuid,
    pick: Pick,
) -> Result<Resolved, ApiError> {
    let outside = |subject| Resolved {
        subject,
        tref: TargetRef {
            in_space: false,
            aim: Aim::Everyone { guests: false },
        },
        sys: None,
    };
    Ok(match pick {
        Pick::Everyone(id) => {
            let facts = match id {
                Some(id) => role_facts(txn, space_id, Some(id), None).await?,
                None => role_facts(txn, space_id, None, Some("members")).await?,
            };
            match facts.as_ref().and_then(|f| f.sys.map(|sys| (f, sys))) {
                Some((facts, sys @ (Sys::Members | Sys::Guests))) => Resolved {
                    subject: RuleSubject::Everyone { role: facts.id },
                    tref: TargetRef {
                        in_space: true,
                        aim: Aim::Everyone {
                            guests: sys == Sys::Guests,
                        },
                    },
                    sys: Some(sys),
                },
                // Not a base role of this space.
                _ => outside(RuleSubject::Everyone {
                    role: id.unwrap_or_default(),
                }),
            }
        }
        Pick::Role(id) => {
            let Some(facts) = role_facts(txn, space_id, Some(id), None).await? else {
                return Ok(outside(RuleSubject::Role { id, system: false }));
            };
            match facts.sys {
                // The base roles are "everyone", whichever way they were named.
                Some(sys @ (Sys::Members | Sys::Guests)) => Resolved {
                    subject: RuleSubject::Everyone { role: facts.id },
                    tref: TargetRef {
                        in_space: true,
                        aim: Aim::Everyone {
                            guests: sys == Sys::Guests,
                        },
                    },
                    sys: Some(sys),
                },
                sys => {
                    let editor_holds = exists(
                        txn,
                        "SELECT 1 FROM space_role_holdings \
                          WHERE space_id = $1 AND user_id = $2 AND role_id = $3",
                        vec![space_id.into(), editor_user.into(), facts.id.into()],
                    )
                    .await?;
                    Resolved {
                        subject: RuleSubject::Role {
                            id: facts.id,
                            system: sys.is_some(),
                        },
                        tref: TargetRef {
                            in_space: true,
                            aim: Aim::Role {
                                position: facts.position,
                                system: sys.is_some(),
                                editor_holds,
                            },
                        },
                        sys,
                    }
                }
            }
        }
        Pick::Group(id) => {
            if !exists(
                txn,
                "SELECT 1 FROM space_groups WHERE id = $1 AND space_id = $2",
                vec![id.into(), space_id.into()],
            )
            .await?
            {
                return Ok(outside(RuleSubject::Group(id)));
            }
            let editor_in = exists(
                txn,
                "SELECT 1 FROM space_group_members WHERE group_id = $1 AND user_id = $2",
                vec![id.into(), editor_user.into()],
            )
            .await?;
            let top_position: Option<i32> = txn
                .query_one_raw(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "SELECT max(r.position) AS top FROM space_group_roles gr \
                       JOIN space_roles r ON r.id = gr.role_id WHERE gr.group_id = $1",
                    [id.into()],
                ))
                .await?
                .map(|row| row.try_get("", "top"))
                .transpose()?
                .flatten();
            Resolved {
                subject: RuleSubject::Group(id),
                tref: TargetRef {
                    in_space: true,
                    aim: Aim::Group {
                        editor_in,
                        top_position,
                    },
                },
                sys: None,
            }
        }
        Pick::User(id) => {
            let standing: Option<String> = txn
                .query_one_raw(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "SELECT standing FROM space_members WHERE space_id = $1 AND user_id = $2",
                    [space_id.into(), id.into()],
                ))
                .await?
                .map(|row| row.try_get("", "standing"))
                .transpose()?;
            let rank = rank_of(txn, space_id, id).await?;
            let (Some(standing), Some(rank)) = (standing, rank) else {
                return Ok(outside(RuleSubject::User(id)));
            };
            Resolved {
                subject: RuleSubject::User(id),
                tref: TargetRef {
                    in_space: true,
                    aim: Aim::User {
                        is_editor: id == editor_user,
                        rank,
                        guest: standing == "guest",
                    },
                },
                sys: None,
            }
        }
        Pick::Audience(id) => {
            if !exists(
                txn,
                "SELECT 1 FROM channels WHERE id = $1 AND space_id = $2",
                vec![id.into(), space_id.into()],
            )
            .await?
            {
                return Ok(outside(RuleSubject::Audience(id)));
            }
            let editor_reads = check::can(
                &state.db,
                space_id,
                editor_user,
                Resource::Channel(id),
                Permission::ChannelView,
            )
            .await?;
            Resolved {
                subject: RuleSubject::Audience(id),
                tref: TargetRef {
                    in_space: true,
                    aim: Aim::Audience { editor_reads },
                },
                sys: None,
            }
        }
    })
}

/// The row without its legacy bit: the part of a system role's level that is stored as a rule.
fn strip(
    kind: Kind,
    sys: Sys,
    allow: PermissionSet,
    deny: PermissionSet,
) -> (PermissionSet, PermissionSet) {
    match legacy_bit(kind, sys) {
        Some(bit) => {
            let bit = PermissionSet::of(&[bit]);
            (allow.minus(bit), deny.minus(bit))
        }
        None => (allow, deny),
    }
}

/// The legacy setting a system role's level stands for, written. `level` is `None` when the line is
/// removed (back to what the base grants).
async fn write_legacy(
    txn: &impl ConnectionTrait,
    space_id: Uuid,
    resource: ResourceRef,
    sys: Sys,
    level: Option<Level>,
) -> Result<bool, ApiError> {
    Ok(match (resource, sys) {
        (ResourceRef::Channel(channel), _) => {
            let role = match sys {
                Sys::Members => "member",
                Sys::Guests => "guest",
                Sys::Administrator => "admin",
            };
            let admitted = level != Some(Level::None);
            crate::messaging::channels::set_role_admitted(txn, space_id, channel, role, admitted)
                .await?
        }
        (ResourceRef::Calendar(calendar), Sys::Members) => {
            let writes = level.is_none_or(|l| l >= Level::Contribute);
            crate::calendar::calendars::set_members_write(txn, calendar, writes).await?;
            false
        }
        _ => false,
    })
}

/// Writing "everyone" below Gérer on a channel or a calendar keeps the Administrator at Gérer there:
/// when no Administrator rule says otherwise, one is written at that level (its own log entry), so
/// administrators keep moderating what they are no longer carried through by the base. Returns
/// whether it wrote, and whether that moved the legacy view bit of a channel.
async fn keep_administrators(
    txn: &impl ConnectionTrait,
    space_id: Uuid,
    actor: Uuid,
    resource: ResourceRef,
) -> Result<Option<bool>, ApiError> {
    let kind = resource.kind();
    if kind == Kind::File {
        return Ok(None);
    }
    let Some(admin) = role_facts(txn, space_id, None, Some("administrator")).await? else {
        return Ok(None);
    };
    let subject = RuleSubject::Role {
        id: admin.id,
        system: true,
    };
    let class = subject.class();
    if let Some(rule) = current_rule(txn, space_id, resource, subject).await? {
        let read = read_system_rule(kind, class, Some(Sys::Administrator), rule.allow, rule.deny);
        // Whatever an Administrator rule already says is left alone.
        if read != LevelRead::NoRule {
            return Ok(None);
        }
    }
    let Ok((allow, deny)) = rule_sets(kind, class, Level::Manage) else {
        return Ok(None);
    };
    let (allow, deny) = strip(kind, Sys::Administrator, allow, deny);
    write_rule(
        txn,
        space_id,
        actor,
        resource,
        subject,
        allow,
        deny,
        Shown {
            before: serde_json::Value::Null,
            after: serde_json::Value::from(level_name(Level::Manage)),
        },
    )
    .await?;
    let moved = write_legacy(
        txn,
        space_id,
        resource,
        Sys::Administrator,
        Some(Level::Manage),
    )
    .await?;
    Ok(Some(moved))
}

/// After a commit that moved a channel's legacy view bit, the sidebars of the people it reaches (or
/// stopped reaching) are told, as the older settings route tells them.
/// Best effort: the change is committed.
async fn tell_channel(state: &AppState, resource: ResourceRef, actor: Uuid) {
    let ResourceRef::Channel(id) = resource else {
        return;
    };
    match crate::entities::channels::Entity::find_by_id(id)
        .one(&state.db)
        .await
    {
        Ok(Some(channel)) => {
            crate::messaging::channels::publish_channel_updated(state, &channel, actor).await;
        }
        Ok(None) => {}
        Err(error) => tracing::warn!(%id, %error, "channel.updated not published"),
    }
}

async fn base_permissions(db: &impl ConnectionTrait, role: Uuid) -> Result<PermissionSet, DbErr> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT permissions FROM space_roles WHERE id = $1",
            [role.into()],
        ))
        .await?;
    let names: Vec<String> = match row {
        Some(row) => row.try_get("", "permissions")?,
        None => Vec::new(),
    };
    Ok(PermissionSet::from_names(&names))
}

#[utoipa::path(
    put,
    path = "/api/v1/spaces/{space_id}/access/{kind}/{resource_id}/entries",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("kind" = String, Path, description = "`channel`, `file` (or a folder) or `calendar`"),
        ("resource_id" = Uuid, Path, description = "The channel, file, folder or calendar")
    ),
    request_body = PutEntryRequest,
    responses(
        (status = 200, description = "The dialog as it is now", body = AccessDto),
        (status = 400, description = "An unusable level or target, `guest_ceiling`, `not_in_space`, or `audience_files_only`"),
        (status = 402, description = "`licence_required`: a rule that is not a preset level, or a custom role"),
        (status = 403, description = "Not an editor of this resource, or `cannot_grant`, `target_above_you`, `reservation_admins_only`"),
        (status = 404, description = "Not a kind of resource"),
        (status = 409, description = "`licence_frozen`, or the default channel cannot be reserved")
    )
)]
pub async fn put_entry(
    State(state): State<AppState>,
    session: AuthSession,
    Path((space_id, kind, resource_id)): Path<(Uuid, String, Uuid)>,
    Json(body): Json<PutEntryRequest>,
) -> Result<Json<AccessDto>, ApiError> {
    let resource = resource_of(&kind, resource_id)?;
    let level = parse_level(&body.level)?;
    let pick = pick_of(&body.target)?;
    // A cheap refusal first; the decision is taken on the editor as the locked state leaves them.
    editor_of(&state, space_id, session.user_id, resource)
        .await?
        .ok_or(ApiError::Forbidden)?;
    let kind = resource.kind();

    let txn = state.db.begin().await?;
    lock_resource(&txn, space_id, resource).await?;
    let editor = editor_of(&state, space_id, session.user_id, resource)
        .await?
        .ok_or(ApiError::Forbidden)?;
    let target = resolve(&state, &txn, space_id, session.user_id, pick).await?;
    let class = target.subject.class();
    let (allow, deny) = match rule_sets(kind, class, level) {
        Ok(sets) => sets,
        // "No access" for one group or person is a deny of the view: a fine rule.
        Err(LevelError::NoneNeedsFineRules) => {
            (PermissionSet::EMPTY, PermissionSet::of(&[resource.view()]))
        }
    };
    let stored = current_rule(&txn, space_id, resource, target.subject).await?;
    let existing = stored.map(|rule| Existing {
        allow: rule.allow,
        deny: rule.deny,
    });
    ensure_writable(
        &editor,
        &resource,
        &target.tref,
        allow,
        deny,
        existing.as_ref(),
    )
    .map_err(|refusal| refusal.into_api(&state.config.pricing_url))?;

    let bridged = target.sys.filter(|&sys| legacy_bit(kind, sys).is_some());
    let mut view_moved = false;
    let changed = if let Some(sys) = bridged {
        let read = stored.map_or(LevelRead::NoRule, |rule| {
            read_system_rule(kind, class, Some(sys), rule.allow, rule.deny)
        });
        let displayed = match read {
            LevelRead::Level(l) => Some(l),
            LevelRead::NoRule => Some(derived_level(
                kind,
                base_permissions(&txn, target.subject.id()).await?,
            )),
            LevelRead::Custom => None,
        };
        if displayed == Some(level) {
            false
        } else {
            let (stored_allow, stored_deny) = strip(kind, sys, allow, deny);
            let before = match read {
                LevelRead::Level(l) => serde_json::Value::from(level_name(l)),
                LevelRead::NoRule => serde_json::Value::Null,
                LevelRead::Custom => stored
                    .map(|r| describe(kind, class, r.allow, r.deny))
                    .unwrap_or_default(),
            };
            let shown = Shown {
                before,
                after: serde_json::Value::from(level_name(level)),
            };
            if stored_allow.is_empty() && stored_deny.is_empty() {
                // Everything of this level lives in the legacy setting: no row holds nothing.
                if let Some(rule) = stored {
                    txn.execute_raw(Statement::from_sql_and_values(
                        DbBackend::Postgres,
                        "DELETE FROM permission_overrides WHERE id = $1",
                        [rule.id.into()],
                    ))
                    .await?;
                }
                let action = if shown.before.is_null() {
                    Action::RuleCreated
                } else {
                    Action::RuleUpdated
                };
                log_rule(
                    &txn,
                    space_id,
                    session.user_id,
                    action,
                    resource,
                    target.subject,
                    shown,
                )
                .await?;
            } else {
                write_rule(
                    &txn,
                    space_id,
                    session.user_id,
                    resource,
                    target.subject,
                    stored_allow,
                    stored_deny,
                    shown,
                )
                .await?;
            }
            view_moved |= write_legacy(&txn, space_id, resource, sys, Some(level)).await?;
            true
        }
    } else if existing.is_some_and(|e| (e.allow, e.deny) == (allow, deny)) {
        false
    } else {
        write_rule(
            &txn,
            space_id,
            session.user_id,
            resource,
            target.subject,
            allow,
            deny,
            Shown {
                before: stored.map_or(serde_json::Value::Null, |r| {
                    describe(kind, class, r.allow, r.deny)
                }),
                after: describe(kind, class, allow, deny),
            },
        )
        .await?;
        true
    };
    // Only on top of a write that changed something: a no-op writes, logs and says nothing.
    if changed && target.sys == Some(Sys::Members) && level < Level::Manage {
        if let Some(moved) = keep_administrators(&txn, space_id, session.user_id, resource).await? {
            view_moved |= moved;
        }
    }
    if changed {
        txn.commit().await?;
        super::changed::announce(&state, space_id).await;
        if view_moved {
            tell_channel(&state, resource, session.user_id).await;
        }
    }
    let editor = editor_of(&state, space_id, session.user_id, resource).await?;
    Ok(Json(
        access_dto(&state, space_id, session.user_id, resource, editor.as_ref()).await?,
    ))
}

#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}/access/{kind}/{resource_id}/entries/{rule_id}",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("kind" = String, Path, description = "`channel`, `file` (or a folder) or `calendar`"),
        ("resource_id" = Uuid, Path, description = "The channel, file, folder or calendar"),
        ("rule_id" = Uuid, Path, description = "The entry's `id`")
    ),
    responses(
        (status = 204, description = "The line is gone: what the base roles grant applies again"),
        (status = 403, description = "Not an editor of this resource, or `target_above_you`, `reservation_admins_only`"),
        (status = 404, description = "Not a rule of this resource"),
        (status = 409, description = "`licence_frozen`")
    )
)]
pub async fn delete_entry(
    State(state): State<AppState>,
    session: AuthSession,
    Path((space_id, kind, resource_id, rule_id)): Path<(Uuid, String, Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let resource = resource_of(&kind, resource_id)?;
    editor_of(&state, space_id, session.user_id, resource)
        .await?
        .ok_or(ApiError::Forbidden)?;
    let kind = resource.kind();

    let txn = state.db.begin().await?;
    lock_resource(&txn, space_id, resource).await?;
    let editor = editor_of(&state, space_id, session.user_id, resource)
        .await?
        .ok_or(ApiError::Forbidden)?;
    let found = rows_on(&txn, space_id, resource, &[resource.id()])
        .await?
        .into_iter()
        .find(|row| row.id == rule_id)
        .ok_or(ApiError::NotFound)?;
    let pick = if let Some(role) = found.role_id {
        Pick::Role(role)
    } else if let Some(group) = found.group_id {
        Pick::Group(group)
    } else if let Some(user) = found.user_id {
        Pick::User(user)
    } else if let Some(channel) = found.audience_id {
        Pick::Audience(channel)
    } else {
        return Err(ApiError::NotFound);
    };
    let target = resolve(&state, &txn, space_id, session.user_id, pick).await?;
    let existing = Existing {
        allow: found.allow,
        deny: found.deny,
    };
    // Deleting is writing nothing over what is there.
    ensure_writable(
        &editor,
        &resource,
        &target.tref,
        PermissionSet::EMPTY,
        PermissionSet::EMPTY,
        Some(&existing),
    )
    .map_err(|refusal| refusal.into_api(&state.config.pricing_url))?;

    let class = target.subject.class();
    let read = read_system_rule(kind, class, target.sys, found.allow, found.deny);
    let before = match read {
        LevelRead::Level(level) => serde_json::Value::from(level_name(level)),
        LevelRead::NoRule => serde_json::Value::Null,
        LevelRead::Custom => describe(kind, class, found.allow, found.deny),
    };
    delete_rule(
        &txn,
        space_id,
        session.user_id,
        resource,
        target.subject,
        rule_id,
        Shown {
            before,
            after: serde_json::Value::Null,
        },
    )
    .await?;
    let view_moved = match target.sys.filter(|&sys| legacy_bit(kind, sys).is_some()) {
        Some(sys) => write_legacy(&txn, space_id, resource, sys, None).await?,
        None => false,
    };
    txn.commit().await?;
    super::changed::announce(&state, space_id).await;
    if view_moved {
        tell_channel(&state, resource, session.user_id).await;
    }
    Ok(StatusCode::NO_CONTENT)
}
