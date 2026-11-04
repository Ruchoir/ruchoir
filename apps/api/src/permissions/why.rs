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

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::Json;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::catalogue::{Family, Permission, PermissionSet};
use super::check::{self, Resource};
use super::engine::{Effect, LevelKind, Opener, Source, Standing, Step};
use super::rule_routes::{can_open, header, resource_of, AccessTargetDto, NamedRefDto};
use super::rules::{editor_of, ResourceRef};
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
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WhyGroupDto {
    pub id: Uuid,
    pub name: String,
}

/// A role a step is about, and the group that carries it when the person holds it that way.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WhyRoleDto {
    pub id: Uuid,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via_group: Option<WhyGroupDto>,
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

    /// Whether the asker may see this folder or channel (the resource itself always).
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
                let via_group = match explained
                    .role_groups
                    .get(&id)
                    .and_then(|groups| groups.first())
                {
                    Some(group) => self.group(*group).await?,
                    None => None,
                };
                let name = self.name("space_roles", id).await?.unwrap_or_default();
                (
                    "role",
                    None,
                    Some(WhyRoleDto {
                        id,
                        name,
                        via_group,
                    }),
                )
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
        })
    }
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
    };

    let family = PermissionSet::of_family(family_of(resource));
    let mut names = Names {
        state: &state,
        space_id,
        asker,
        resource,
        person: person.clone(),
        cache: HashMap::new(),
        seen: HashMap::new(),
    };
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
