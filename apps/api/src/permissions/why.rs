//! "Pourquoi ?": why a person has, or lacks, access to a channel, a file or folder, or a calendar.
//!
//! The steps are the engine's own trace ([`check::explain_for`]), the very path that decides, so
//! the explanation can never disagree with the decision: `result` is the decision, and every
//! permission points at the last step that touched it. Nothing is written and nothing is logged.
//!
//! Who may ask: whoever may open the resource (or edit its access), about themselves; about
//! somebody else, whoever holds `members.view` (a guest never does). Nothing is named that the
//! asker could not see in the access dialog: a folder above they cannot open, a channel whose
//! readers a rule names and they cannot read stay "hidden".
//!
//! A hidden step still says that a rule exists there, without naming its resource: this is
//! deliberate, the person's access depends on it and an explanation that skipped it would
//! disagree with the decision.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::Json;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::catalogue::{Family, Permission, PermissionSet};
use super::check::{self, Resource};
use super::engine::{Effect, LevelKind, Opener, Source, Standing, Step};
use super::levels::{Kind, Target};
use super::rule_routes::{can_open, header, resource_of, AccessTargetDto, NamedRefDto};
use super::rules::{editor_of, rule_level_word, ResourceRef};
use crate::auth::extract::AuthSession;
use crate::messaging::error::ApiError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct WhyQuery {
    /// The person to explain; the caller when absent.
    pub user_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WhyPersonDto {
    pub id: Uuid,
    pub name: String,
    /// `owner`, `member` or `guest`.
    pub standing: &'static str,
    /// Every role the person holds in the space beyond the base roles, given to them or carried by
    /// one of their groups, by name; whether or not a step names it.
    pub roles: Vec<WhyRoleDto>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WhyGroupDto {
    pub id: Uuid,
    pub name: String,
}

/// A role a step is about, and how the person holds it.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WhyRoleDto {
    pub id: Uuid,
    pub name: String,
    /// The role is given to the person themselves (or, for a role no group carries, by their
    /// standing). It can be true together with `via_groups`: they hold it both ways.
    pub direct: bool,
    /// Every group of theirs that carries the role, sorted by name.
    pub via_groups: Vec<WhyGroupDto>,
}

/// One change, in the order the engine applied it.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct StepDto {
    /// Position, from 1.
    pub n: u32,
    /// `base`, `role`, `rule`, `private_lock` (taken away, or `granted` when a rule lifted it),
    /// `guest_ceiling`, `owner`, `author`, `archived`, `joined`, and `unseen`, `conversation`,
    /// `message`, `event` for the paths to a file that are not rules.
    pub kind: &'static str,
    pub permission: &'static str,
    /// `granted` or `removed`.
    pub effect: &'static str,
    /// Where it happened: a folder, the file, the channel or the calendar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<NamedRefDto>,
    /// Whom the rule is about (`kind: rule`, or the rule that lifted a private lock).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<AccessTargetDto>,
    /// The role (`kind: role`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<WhyRoleDto>,
    /// The level of the rule behind a `rule` step (`none`, `read`, `contribute`, `manage` or
    /// `custom`), read like the access dialog reads it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_level: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct StepRefDto {
    pub n: u32,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WhyResultDto {
    pub permission: &'static str,
    pub granted: bool,
    /// The last step that touched it; absent when nothing did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<StepRefDto>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WhyDto {
    pub person: WhyPersonDto,
    pub steps: Vec<StepDto>,
    /// One line per permission of the resource's family, the engine's decision.
    pub result: Vec<WhyResultDto>,
}

fn family_of(resource: ResourceRef) -> Family {
    match resource {
        ResourceRef::Channel(_) => Family::Channel,
        ResourceRef::File(_) => Family::Files,
        ResourceRef::Calendar(_) => Family::Calendar,
    }
}

fn standing_word(standing: Standing) -> &'static str {
    match standing {
        Standing::Owner => "owner",
        Standing::Member => "member",
        Standing::Guest => "guest",
    }
}

struct Names<'a> {
    state: &'a AppState,
    space_id: Uuid,
    asker: Uuid,
    resource: ResourceRef,
    person: WhyPersonDto,
    /// The roles given to the person themselves, not through a group.
    direct_roles: HashSet<Uuid>,
    cache: HashMap<(&'static str, Uuid), Option<String>>,
    seen: HashMap<(&'static str, Uuid), bool>,
}

impl Names<'_> {
    async fn name(&mut self, table: &'static str, id: Uuid) -> Result<Option<String>, ApiError> {
        if let Some(known) = self.cache.get(&(table, id)) {
            return Ok(known.clone());
        }
        let found = self
            .state
            .db
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                format!("SELECT name::text AS name FROM {table} WHERE id = $1 AND space_id = $2"),
                [id.into(), self.space_id.into()],
            ))
            .await?
            .map(|row| row.try_get::<String>("", "name"))
            .transpose()?;
        self.cache.insert((table, id), found.clone());
        Ok(found)
    }

    /// Whether the asker may see this folder or channel (the resource itself always, since the
    /// asker was let in to explain it).
    async fn visible(&mut self, resource: Resource, id: Uuid) -> Result<bool, ApiError> {
        if id == self.resource.id() {
            return Ok(true);
        }
        let (key, permission) = match resource {
            Resource::Channel(_) => ("channel", Permission::ChannelView),
            _ => ("file", Permission::FilesView),
        };
        if let Some(known) = self.seen.get(&(key, id)) {
            return Ok(*known);
        }
        let may = check::can(
            &self.state.db,
            self.space_id,
            self.asker,
            resource,
            permission,
        )
        .await?;
        self.seen.insert((key, id), may);
        Ok(may)
    }

    async fn level(&mut self, kind: LevelKind, id: Uuid) -> Result<NamedRefDto, ApiError> {
        let (word, table, resource) = match kind {
            LevelKind::Channel => ("channel", "channels", Resource::Channel(id)),
            LevelKind::Calendar => ("calendar", "calendars", Resource::Calendar(id)),
            LevelKind::Folder | LevelKind::File => ("file", "files", Resource::File(id)),
        };
        // A calendar level is always the calendar being explained (calendars do not nest), which
        // the asker may already open, so it is shown; folders and channels may be someone else's.
        let shown = if kind == LevelKind::Calendar {
            true
        } else {
            self.visible(resource, id).await?
        };
        let name = if shown {
            self.name(table, id).await?
        } else {
            None
        };
        Ok(match name {
            Some(name) => NamedRefDto {
                kind: word,
                id: Some(id),
                name: Some(name),
                hidden: None,
            },
            None => NamedRefDto {
                kind: word,
                id: None,
                name: None,
                hidden: Some(true),
            },
        })
    }

    async fn group(&mut self, id: Uuid) -> Result<Option<WhyGroupDto>, ApiError> {
        Ok(self
            .name("space_groups", id)
            .await?
            .map(|name| WhyGroupDto { id, name }))
    }

    async fn target(
        &mut self,
        source: Source,
        standing: Standing,
    ) -> Result<Option<AccessTargetDto>, ApiError> {
        let named = |kind: &'static str, id: Option<Uuid>, name: Option<String>| AccessTargetDto {
            kind,
            id,
            name,
            hidden: None,
        };
        Ok(Some(match source {
            Source::BaseRole => named(
                "everyone",
                None,
                Some(
                    if standing == Standing::Guest {
                        "@guests"
                    } else {
                        "@members"
                    }
                    .to_owned(),
                ),
            ),
            Source::Role(id) | Source::Lifted(Opener::Role(id)) => {
                let name = self.name("space_roles", id).await?;
                named("role", Some(id), name)
            }
            Source::Group(id) | Source::Lifted(Opener::Group(id)) => {
                let name = self.name("space_groups", id).await?;
                named("group", Some(id), name)
            }
            Source::User | Source::Lifted(Opener::User) => {
                named("user", Some(self.person.id), Some(self.person.name.clone()))
            }
            Source::Audience(id) => {
                if self.visible(Resource::Channel(id), id).await? {
                    let name = self.name("channels", id).await?;
                    named("audience", Some(id), name)
                } else {
                    AccessTargetDto {
                        kind: "audience",
                        id: None,
                        name: None,
                        hidden: Some(true),
                    }
                }
            }
            Source::ChannelRole(role) => named("channel_role", None, Some(role.to_owned())),
            Source::Implicit(_) => return Ok(None),
        }))
    }

    /// The level of the rule a step comes from, read like the access dialog reads it. Absent for
    /// a source that is no stored rule of a role, group, person or audience.
    async fn rule_level(
        &mut self,
        source: Source,
        kind: LevelKind,
        id: Uuid,
    ) -> Result<Option<&'static str>, ApiError> {
        let (subject, class, key) = match source {
            Source::Role(role) => {
                let system = self
                    .state
                    .db
                    .query_one_raw(Statement::from_sql_and_values(
                        DbBackend::Postgres,
                        "SELECT system_key IS NOT NULL AS system FROM space_roles WHERE id = $1",
                        [role.into()],
                    ))
                    .await?
                    .map(|row| row.try_get::<bool>("", "system"))
                    .transpose()?
                    .unwrap_or(false);
                (role, Target::Role { system }, "role_id")
            }
            Source::Group(group) => (group, Target::Group, "group_id"),
            Source::User => (self.person.id, Target::User, "user_id"),
            Source::Audience(channel) => (channel, Target::Audience, "audience_channel_id"),
            _ => return Ok(None),
        };
        let (resource, level_kind) = match kind {
            LevelKind::Channel => ("channel_id", Kind::Channel),
            LevelKind::Calendar => ("calendar_id", Kind::Calendar),
            LevelKind::Folder | LevelKind::File => ("file_id", Kind::File),
        };
        let Some(row) = self
            .state
            .db
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                format!(
                    "SELECT allow, deny FROM permission_overrides \
                      WHERE space_id = $1 AND {resource} = $2 AND {key} = $3"
                ),
                [self.space_id.into(), id.into(), subject.into()],
            ))
            .await?
        else {
            return Ok(None);
        };
        let allow: Vec<String> = row.try_get("", "allow")?;
        let deny: Vec<String> = row.try_get("", "deny")?;
        Ok(Some(rule_level_word(
            level_kind,
            class,
            PermissionSet::from_names(&allow),
            PermissionSet::from_names(&deny),
        )))
    }

    /// A role as the person holds it: given to them, and every group of theirs carrying it.
    async fn role_held(
        &mut self,
        id: Uuid,
        explained: &check::Explained,
    ) -> Result<Option<WhyRoleDto>, ApiError> {
        let Some(name) = self.name("space_roles", id).await? else {
            return Ok(None);
        };
        // Every group of the person's is visible to whoever may ask: a guest only ever explains
        // themselves, so the groups are their own.
        let mut via_groups = Vec::new();
        for group in explained.role_groups.get(&id).into_iter().flatten() {
            via_groups.extend(self.group(*group).await?);
        }
        via_groups.sort_by_key(|group| group.name.to_lowercase());
        let direct = self.direct_roles.contains(&id) || via_groups.is_empty();
        Ok(Some(WhyRoleDto {
            id,
            name,
            direct,
            via_groups,
        }))
    }

    async fn step(
        &mut self,
        n: u32,
        step: &Step,
        explained: &check::Explained,
    ) -> Result<StepDto, ApiError> {
        let standing = explained.standing;
        let at_a_level = step.level.is_some();
        let (kind, target, role) = match step.source {
            Source::BaseRole if !at_a_level => ("base", None, None),
            Source::Role(id) if !at_a_level => {
                let role = match self.role_held(id, explained).await? {
                    Some(role) => role,
                    None => WhyRoleDto {
                        id,
                        name: String::new(),
                        direct: self.direct_roles.contains(&id),
                        via_groups: Vec::new(),
                    },
                };
                ("role", None, Some(role))
            }
            Source::Lifted(_) => (
                "private_lock",
                self.target(step.source, standing).await?,
                None,
            ),
            Source::Implicit(word) => (
                match word {
                    "guest" => "guest_ceiling",
                    "private" => "private_lock",
                    other => other,
                },
                None,
                None,
            ),
            source => ("rule", self.target(source, standing).await?, None),
        };
        let level = match step.level {
            Some((kind, id)) => Some(self.level(kind, id).await?),
            None => None,
        };
        let rule_level = match (kind, step.level) {
            ("rule", Some((level_kind, level_id))) => {
                self.rule_level(step.source, level_kind, level_id).await?
            }
            _ => None,
        };
        Ok(StepDto {
            n,
            kind,
            permission: step.permission.name(),
            effect: match step.effect {
                Effect::Granted => "granted",
                Effect::Removed => "removed",
            },
            level,
            target,
            role,
            rule_level,
        })
    }
}

async fn direct_roles_of(
    state: &AppState,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<HashSet<Uuid>, ApiError> {
    let mut roles = HashSet::new();
    for row in state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT role_id FROM space_role_assignments WHERE space_id = $1 AND user_id = $2",
            [space_id.into(), user_id.into()],
        ))
        .await?
    {
        roles.insert(row.try_get("", "role_id")?);
    }
    Ok(roles)
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/access/{kind}/{resource_id}/why",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("kind" = String, Path, description = "`channel`, `file` (or a folder) or `calendar`"),
        ("resource_id" = Uuid, Path, description = "The channel, file, folder or calendar"),
        ("user_id" = Option<Uuid>, Query, description = "The person to explain; the caller when absent")
    ),
    responses(
        (status = 200, description = "The steps that give or take each permission, then the result", body = WhyDto),
        (status = 403, description = "Explaining somebody else needs the right to see members"),
        (status = 404, description = "A resource the caller cannot see, or a person not in the space")
    )
)]
pub async fn read_why(
    State(state): State<AppState>,
    session: AuthSession,
    Path((space_id, kind, resource_id)): Path<(Uuid, String, Uuid)>,
    Query(query): Query<WhyQuery>,
) -> Result<Json<WhyDto>, ApiError> {
    let resource = resource_of(&kind, resource_id)?;
    let asker = session.user_id;
    // A resource the caller cannot open (nor edit the access of) does not exist for them.
    if editor_of(&state, space_id, asker, resource)
        .await?
        .is_none()
        && !can_open(&state, space_id, asker, resource).await?
    {
        return Err(ApiError::NotFound);
    }
    let person_id = query.user_id.unwrap_or(asker);
    if person_id != asker
        && !check::can(
            &state.db,
            space_id,
            asker,
            Resource::Space,
            Permission::MembersView,
        )
        .await?
    {
        return Err(ApiError::Forbidden);
    }
    // Somebody who is not in the space is not a person to explain.
    let explained = check::explain_for(&state.db, space_id, person_id, resource.engine())
        .await?
        .ok_or(ApiError::NotFound)?;
    // The resource exists (the asker could open it), but its row may be gone in the meantime.
    let _ = header(&state.db, space_id, resource)
        .await
        .map_err(|_| ApiError::NotFound)?;
    let name: String = state
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT display_name FROM users WHERE id = $1",
            [person_id.into()],
        ))
        .await?
        .ok_or(ApiError::NotFound)?
        .try_get("", "display_name")?;
    let person = WhyPersonDto {
        id: person_id,
        name,
        standing: standing_word(explained.standing),
        roles: Vec::new(),
    };

    let family = PermissionSet::of_family(family_of(resource));
    let mut names = Names {
        state: &state,
        space_id,
        asker,
        resource,
        person: person.clone(),
        direct_roles: direct_roles_of(&state, space_id, person_id).await?,
        cache: HashMap::new(),
        seen: HashMap::new(),
    };
    // Every role the person holds beyond the base ones, direct or through a group: what the loader
    // already read, so nothing new is loaded.
    let mut role_ids: Vec<Uuid> = names
        .direct_roles
        .iter()
        .copied()
        .chain(explained.role_groups.keys().copied())
        .collect();
    role_ids.sort();
    role_ids.dedup();
    let mut roles = Vec::new();
    for id in role_ids {
        roles.extend(names.role_held(id, &explained).await?);
    }
    roles.sort_by_key(|role| role.name.to_lowercase());
    let person = WhyPersonDto { roles, ..person };
    let mut steps = Vec::new();
    let mut last: HashMap<Permission, u32> = HashMap::new();
    for step in explained
        .decision
        .trace
        .iter()
        .filter(|step| family.contains(step.permission))
    {
        let n = steps.len() as u32 + 1;
        last.insert(step.permission, n);
        steps.push(names.step(n, step, &explained).await?);
    }
    let result = family
        .iter()
        .map(|permission| WhyResultDto {
            permission: permission.name(),
            granted: explained.decision.granted.contains(permission),
            reason: last.get(&permission).map(|n| StepRefDto { n: *n }),
        })
        .collect();
    Ok(Json(WhyDto {
        person,
        steps,
        result,
    }))
}
