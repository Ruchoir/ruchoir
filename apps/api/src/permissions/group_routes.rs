//! A space's groups over HTTP, free in every edition: list, create, rename, delete, and who is in
//! them. Which roles a group carries and who manages it are the enterprise edition's to write;
//! this module only shows them, and says through [`GroupMay`] what the caller may do.
//!
//! Every change is one transaction: the group row is locked (`FOR UPDATE`) and re-read, the act
//! is decided on what was read ([`decide`], the same function the `may` flags ask), the change and
//! its audit entry are written together, and the space is told afterwards. A request that changes
//! nothing writes nothing and says nothing.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use sea_orm::{
    ConnectionTrait, DbBackend, DbErr, SqlErr, Statement, TransactionTrait, Value as SqlValue,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::catalogue::Permission;
use super::groups::{
    actor, decide, group, groups_of, name_taken, validate_group_name, GroupAct, GroupActor,
    GroupRow, GroupSource,
};
use crate::audit::{record, Action, Target};
use crate::auth::extract::AuthSession;
use crate::messaging::error::ApiError;
use crate::state::AppState;

/// The longest group description, in characters (the table's own limit).
const DESCRIPTION_MAX: usize = 280;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/spaces/{space_id}/groups",
            get(list_groups).post(create_group),
        )
        .route(
            "/api/v1/spaces/{space_id}/groups/{group_id}",
            axum::routing::patch(update_group).delete(delete_group),
        )
        .route(
            "/api/v1/spaces/{space_id}/groups/{group_id}/members",
            axum::routing::post(add_group_members),
        )
        .route(
            "/api/v1/spaces/{space_id}/groups/{group_id}/members/{user_id}",
            delete(remove_group_member),
        )
}

/// What the caller may do to a group, each flag asking [`decide`] about a representative act, so
/// the screen and the server never disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub struct GroupMay {
    /// Rename it or change its description.
    pub edit: bool,
    pub delete: bool,
    /// Put people in it and take them out.
    pub change_members: bool,
    /// Change the roles it carries (enterprise edition).
    pub change_roles: bool,
    /// Name its managers (enterprise edition).
    pub appoint: bool,
}

/// One group of the space.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GroupDto {
    pub id: Uuid,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `manual`, or `directory` for a group mirrored from a directory (read-only).
    pub source: String,
    /// Everyone in it, managers included.
    pub member_ids: Vec<Uuid>,
    /// The members who manage it.
    pub manager_ids: Vec<Uuid>,
    /// The roles it carries, strongest first.
    pub role_ids: Vec<Uuid>,
    pub may: GroupMay,
}

/// What `actor` may do to `group`.
pub fn may(actor: &GroupActor, group: &GroupRow) -> GroupMay {
    GroupMay {
        edit: decide(actor, group, GroupAct::Edit).is_ok(),
        delete: decide(actor, group, GroupAct::Delete).is_ok(),
        change_members: decide(actor, group, GroupAct::Add(&[])).is_ok(),
        change_roles: decide(
            actor,
            group,
            GroupAct::SetRoles {
                after: &group.roles,
            },
        )
        .is_ok(),
        appoint: decide(actor, group, GroupAct::SetManagers(&[])).is_ok(),
    }
}

fn dto_of(actor: &GroupActor, group: &GroupRow) -> GroupDto {
    GroupDto {
        id: group.id,
        name: group.name.clone(),
        description: group.description.clone(),
        source: match group.source {
            GroupSource::Manual => "manual",
            GroupSource::Directory => "directory",
        }
        .to_owned(),
        member_ids: group.members.iter().map(|m| m.user_id).collect(),
        manager_ids: group
            .members
            .iter()
            .filter(|m| m.is_manager)
            .map(|m| m.user_id)
            .collect(),
        role_ids: group.roles.iter().map(|r| r.id).collect(),
        may: may(actor, group),
    }
}

/// `group` as `viewer` reads it. `403` for someone who is not in the space.
pub async fn group_dto(
    state: &AppState,
    space_id: Uuid,
    viewer: Uuid,
    group: &GroupRow,
) -> Result<GroupDto, ApiError> {
    let actor = actor(state, space_id, viewer)
        .await?
        .ok_or(ApiError::Forbidden)?;
    Ok(dto_of(&actor, group))
}

/// Many groups as `viewer` reads them; the actor is worked out once.
pub async fn group_dtos(
    state: &AppState,
    space_id: Uuid,
    viewer: Uuid,
    groups: &[GroupRow],
) -> Result<Vec<GroupDto>, ApiError> {
    let actor = actor(state, space_id, viewer)
        .await?
        .ok_or(ApiError::Forbidden)?;
    Ok(groups.iter().map(|g| dto_of(&actor, g)).collect())
}

/// The caller as an actor of the space, or `403`.
async fn caller(state: &AppState, space_id: Uuid, user: Uuid) -> Result<GroupActor, ApiError> {
    actor(state, space_id, user)
        .await?
        .ok_or(ApiError::Forbidden)
}

/// Lock the group row and read the group as it stands: what every write decides on. `404` for a
/// group that is not the space's, or that a concurrent delete just removed.
async fn lock(
    txn: &impl ConnectionTrait,
    space_id: Uuid,
    group_id: Uuid,
) -> Result<GroupRow, ApiError> {
    let locked = txn
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id FROM space_groups WHERE id = $1 AND space_id = $2 FOR UPDATE",
            [group_id.into(), space_id.into()],
        ))
        .await?;
    if locked.is_none() {
        return Err(ApiError::NotFound);
    }
    group(txn, space_id, group_id)
        .await?
        .ok_or(ApiError::NotFound)
}

fn refused(state: &AppState, refusal: super::groups::Refusal) -> ApiError {
    refusal.into_api(&state.config.pricing_url)
}

/// A description as stored: trimmed, `None` when blank, at most 280 characters.
fn clean_description(text: &str) -> Result<Option<String>, ApiError> {
    let text = text.trim();
    if text.chars().count() > DESCRIPTION_MAX {
        return Err(ApiError::BadRequest(
            "a group description has at most 280 characters",
        ));
    }
    Ok((!text.is_empty()).then(|| text.to_owned()))
}

/// The unique index on (space, name) answering is `group_name_taken`; anything else is a failure.
fn name_clash(error: DbErr) -> ApiError {
    if matches!(error.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) {
        name_taken()
    } else {
        error.into()
    }
}

fn role_names(group: &GroupRow) -> Vec<&str> {
    group.roles.iter().map(|r| r.name.as_str()).collect()
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/groups",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "The space's groups, by name", body = [GroupDto]),
        (status = 403, description = "Not someone who reads this space's member directory")
    )
)]
pub async fn list_groups(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Json<Vec<GroupDto>>, ApiError> {
    let actor = caller(&state, space_id, session.user_id).await?;
    if !actor.rights.contains(Permission::MembersView) {
        return Err(ApiError::Forbidden);
    }
    let groups = groups_of(&state.db, space_id).await?;
    Ok(Json(groups.iter().map(|g| dto_of(&actor, g)).collect()))
}

/// A new group.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateGroupRequest {
    /// 1 to 60 characters, unique in the space whatever the case, not starting with `@` or `#`,
    /// not a broadcast word (`here`, `channel`, `everyone`, `all` and their translations).
    pub name: String,
    /// At most 280 characters.
    pub description: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/groups",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    request_body = CreateGroupRequest,
    responses(
        (status = 201, description = "The new group", body = GroupDto),
        (status = 400, description = "An unusable name (`group_name_reserved`, `group_name_invalid`) or description"),
        (status = 403, description = "Needs `groups.manage`"),
        (status = 409, description = "`group_name_taken`")
    )
)]
pub async fn create_group(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Json(body): Json<CreateGroupRequest>,
) -> Result<(StatusCode, Json<GroupDto>), ApiError> {
    let actor = caller(&state, space_id, session.user_id).await?;
    if !actor.rights.contains(Permission::GroupsManage) {
        return Err(ApiError::Forbidden);
    }
    let name = validate_group_name(&body.name)?;
    let description = match body.description.as_deref() {
        Some(text) => clean_description(text)?,
        None => None,
    };

    let txn = state.db.begin().await?;
    let id: Uuid = txn
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO space_groups (space_id, name, description) VALUES ($1, $2, $3) RETURNING id",
            [space_id.into(), name.clone().into(), description.clone().into()],
        ))
        .await
        .map_err(name_clash)?
        .ok_or(ApiError::NotFound)?
        .try_get("", "id")?;
    record(
        &txn,
        space_id,
        Some(session.user_id),
        Action::GroupCreated,
        Target::Group(id),
        serde_json::json!({ "name": name, "description": description }),
    )
    .await?;
    let created = group(&txn, space_id, id).await?.ok_or(ApiError::NotFound)?;
    txn.commit().await?;
    super::changed::announce(&state, space_id).await;
    Ok((StatusCode::CREATED, Json(dto_of(&actor, &created))))
}

/// What to change about a group; what is absent stays.
#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateGroupRequest {
    pub name: Option<String>,
    /// Blank clears it.
    pub description: Option<String>,
}

#[utoipa::path(
    patch,
    path = "/api/v1/spaces/{space_id}/groups/{group_id}",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("group_id" = Uuid, Path, description = "Group id")
    ),
    request_body = UpdateGroupRequest,
    responses(
        (status = 200, description = "The group as it is now", body = GroupDto),
        (status = 400, description = "An unusable name or description"),
        (status = 403, description = "Needs `groups.manage`"),
        (status = 404, description = "Not a group of this space"),
        (status = 409, description = "`group_name_taken`, or `group_from_directory`")
    )
)]
pub async fn update_group(
    State(state): State<AppState>,
    session: AuthSession,
    Path((space_id, group_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateGroupRequest>,
) -> Result<Json<GroupDto>, ApiError> {
    let actor = caller(&state, space_id, session.user_id).await?;
    let txn = state.db.begin().await?;
    let current = lock(&txn, space_id, group_id).await?;
    decide(&actor, &current, GroupAct::Edit).map_err(|r| refused(&state, r))?;
    let name = match body.name.as_deref() {
        Some(name) => validate_group_name(name)?,
        None => current.name.clone(),
    };
    let description = match body.description.as_deref() {
        Some(text) => clean_description(text)?,
        None => current.description.clone(),
    };
    if name == current.name && description == current.description {
        return Ok(Json(dto_of(&actor, &current)));
    }
    txn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE space_groups SET name = $2, description = $3 WHERE id = $1",
        [
            group_id.into(),
            name.clone().into(),
            SqlValue::from(description.clone()),
        ],
    ))
    .await
    .map_err(name_clash)?;
    record(
        &txn,
        space_id,
        Some(session.user_id),
        Action::GroupUpdated,
        Target::Group(group_id),
        serde_json::json!({
            "before": { "name": current.name, "description": current.description },
            "after": { "name": name, "description": description },
        }),
    )
    .await?;
    let updated = group(&txn, space_id, group_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    txn.commit().await?;
    super::changed::announce(&state, space_id).await;
    Ok(Json(dto_of(&actor, &updated)))
}

#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}/groups/{group_id}",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("group_id" = Uuid, Path, description = "Group id")
    ),
    responses(
        (status = 204, description = "The group is gone, and the roles it carried with it"),
        (status = 402, description = "`licence_required`: it carries roles"),
        (status = 403, description = "Needs `groups.manage`, and every role it carries below the caller"),
        (status = 404, description = "Not a group of this space"),
        (status = 409, description = "`group_from_directory`, or `licence_frozen`")
    )
)]
pub async fn delete_group(
    State(state): State<AppState>,
    session: AuthSession,
    Path((space_id, group_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let actor = caller(&state, space_id, session.user_id).await?;
    let txn = state.db.begin().await?;
    let current = lock(&txn, space_id, group_id).await?;
    decide(&actor, &current, GroupAct::Delete).map_err(|r| refused(&state, r))?;
    record(
        &txn,
        space_id,
        Some(session.user_id),
        Action::GroupDeleted,
        Target::Group(group_id),
        serde_json::json!({
            "name": current.name,
            "members": current.members.len(),
            "roles": role_names(&current),
        }),
    )
    .await?;
    txn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM space_groups WHERE id = $1 AND space_id = $2",
        [group_id.into(), space_id.into()],
    ))
    .await?;
    txn.commit().await?;
    super::changed::announce(&state, space_id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// People to put in a group.
#[derive(Debug, Deserialize, ToSchema)]
pub struct AddGroupMembersRequest {
    /// People of the space, of any standing. Those already in are ignored.
    pub user_ids: Vec<Uuid>,
}

#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/groups/{group_id}/members",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("group_id" = Uuid, Path, description = "Group id")
    ),
    request_body = AddGroupMembersRequest,
    responses(
        (status = 200, description = "The group as it is now", body = GroupDto),
        (status = 400, description = "`not_in_space`: someone is not a person of this space"),
        (status = 402, description = "`licence_required`: the group carries roles, or the caller acts as its manager"),
        (status = 403, description = "Neither `groups.manage` nor a manager of the group; `role_above_you`, `no_self_role`"),
        (status = 404, description = "Not a group of this space"),
        (status = 409, description = "`group_from_directory`, or `licence_frozen`")
    )
)]
pub async fn add_group_members(
    State(state): State<AppState>,
    session: AuthSession,
    Path((space_id, group_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<AddGroupMembersRequest>,
) -> Result<Json<GroupDto>, ApiError> {
    let actor = caller(&state, space_id, session.user_id).await?;
    let mut ids = body.user_ids;
    ids.sort();
    ids.dedup();

    let txn = state.db.begin().await?;
    let current = lock(&txn, space_id, group_id).await?;
    decide(&actor, &current, GroupAct::Add(&ids)).map_err(|r| refused(&state, r))?;
    let known = txn
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT count(*)::bigint AS n FROM space_members \
              WHERE space_id = $1 AND user_id = ANY($2)",
            [space_id.into(), ids.clone().into()],
        ))
        .await?
        .ok_or(ApiError::NotFound)?
        .try_get::<i64>("", "n")?;
    if known != ids.len() as i64 {
        return Err(ApiError::BadRequestCode {
            code: "not_in_space",
            message: "Everyone added to a group must be a person of the space.",
        });
    }
    let fresh: Vec<Uuid> = ids
        .into_iter()
        .filter(|id| !current.members.iter().any(|m| m.user_id == *id))
        .collect();
    if fresh.is_empty() {
        return Ok(Json(dto_of(&actor, &current)));
    }
    txn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO space_group_members (group_id, space_id, user_id) \
         SELECT $1, $2, u FROM unnest($3::uuid[]) AS u ON CONFLICT DO NOTHING",
        [group_id.into(), space_id.into(), fresh.clone().into()],
    ))
    .await?;
    record(
        &txn,
        space_id,
        Some(session.user_id),
        Action::GroupMembersAdded,
        Target::Group(group_id),
        serde_json::json!({ "user_ids": fresh, "roles": role_names(&current) }),
    )
    .await?;
    let updated = group(&txn, space_id, group_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    txn.commit().await?;
    super::changed::announce(&state, space_id).await;
    Ok(Json(dto_of(&actor, &updated)))
}

#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}/groups/{group_id}/members/{user_id}",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("group_id" = Uuid, Path, description = "Group id"),
        ("user_id" = Uuid, Path, description = "The person to take out; the caller's own id leaves the group")
    ),
    responses(
        (status = 204, description = "They are out (or were not in)"),
        (status = 402, description = "`licence_required`: the group carries roles, or the caller acts as its manager"),
        (status = 403, description = "Neither `groups.manage` nor a manager of the group; `role_above_you`, `no_self_role`, `manager_protected`"),
        (status = 404, description = "Not a group of this space, or the caller is not in it (leaving)"),
        (status = 409, description = "`group_from_directory`, or `licence_frozen`")
    )
)]
pub async fn remove_group_member(
    State(state): State<AppState>,
    session: AuthSession,
    Path((space_id, group_id, user_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let actor = caller(&state, space_id, session.user_id).await?;
    let txn = state.db.begin().await?;
    let current = lock(&txn, space_id, group_id).await?;
    let ids = [user_id];
    let act = if user_id == session.user_id {
        GroupAct::Leave
    } else {
        GroupAct::Remove(&ids)
    };
    decide(&actor, &current, act).map_err(|r| refused(&state, r))?;
    if !current.members.iter().any(|m| m.user_id == user_id) {
        return Ok(StatusCode::NO_CONTENT);
    }
    txn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM space_group_members WHERE group_id = $1 AND user_id = $2",
        [group_id.into(), user_id.into()],
    ))
    .await?;
    record(
        &txn,
        space_id,
        Some(session.user_id),
        Action::GroupMembersRemoved,
        Target::Group(group_id),
        serde_json::json!({ "user_ids": [user_id], "roles": role_names(&current) }),
    )
    .await?;
    txn.commit().await?;
    super::changed::announce(&state, space_id).await;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::catalogue::PermissionSet;
    use crate::permissions::delegation::{Rank, RoleRow};
    use crate::permissions::groups::{GroupMember, Paid};

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    fn actor_with(rights: &[Permission], rank: Rank, owner: bool, paid: Paid) -> GroupActor {
        let mut set = PermissionSet::default();
        for right in rights {
            set.insert(*right);
        }
        GroupActor {
            user_id: id(1),
            owner,
            rank,
            rights: set,
            paid,
        }
    }

    fn role(position: i32) -> RoleRow {
        RoleRow {
            id: id(100 + position as u128),
            system_key: None,
            name: format!("role{position}"),
            colour: None,
            position,
            permissions: PermissionSet::default(),
        }
    }

    fn group_with(source: GroupSource, members: Vec<GroupMember>, roles: Vec<RoleRow>) -> GroupRow {
        GroupRow {
            id: id(500),
            space_id: id(600),
            name: "Team".into(),
            description: None,
            source,
            members,
            roles,
        }
    }

    fn member(n: u128, is_manager: bool) -> GroupMember {
        GroupMember {
            user_id: id(n),
            is_manager,
            guest: false,
        }
    }

    #[test]
    fn may_matches_decide() {
        let both = [Permission::GroupsManage, Permission::RolesManage];
        let actors = [
            actor_with(&[], Rank::Position(0), false, Paid::Enterprise),
            actor_with(
                &[Permission::GroupsManage],
                Rank::Position(50),
                false,
                Paid::Enterprise,
            ),
            actor_with(&both, Rank::Position(50), false, Paid::Enterprise),
            actor_with(&both, Rank::Position(50), false, Paid::Community),
            actor_with(&both, Rank::Position(50), false, Paid::Frozen),
            actor_with(&both, Rank::Owner, true, Paid::Enterprise),
        ];
        let groups = [
            group_with(GroupSource::Manual, vec![], vec![]),
            group_with(GroupSource::Manual, vec![member(1, true)], vec![]),
            group_with(GroupSource::Manual, vec![member(1, false)], vec![role(40)]),
            group_with(
                GroupSource::Manual,
                vec![member(2, true)],
                vec![role(40), role(60)],
            ),
            group_with(GroupSource::Directory, vec![member(1, true)], vec![]),
        ];
        for actor in &actors {
            for group in &groups {
                let got = may(actor, group);
                assert_eq!(got.edit, decide(actor, group, GroupAct::Edit).is_ok());
                assert_eq!(got.delete, decide(actor, group, GroupAct::Delete).is_ok());
                assert_eq!(
                    got.change_members,
                    decide(actor, group, GroupAct::Add(&[])).is_ok()
                );
                assert_eq!(
                    got.change_roles,
                    decide(
                        actor,
                        group,
                        GroupAct::SetRoles {
                            after: &group.roles
                        }
                    )
                    .is_ok()
                );
                assert_eq!(
                    got.appoint,
                    decide(actor, group, GroupAct::SetManagers(&[])).is_ok()
                );
            }
        }
        // And the flags say what a person would expect of them.
        let plain = &groups[0];
        let hr = &actors[2];
        assert_eq!(
            may(hr, plain),
            GroupMay {
                edit: true,
                delete: true,
                change_members: true,
                change_roles: true,
                appoint: true
            }
        );
        let community = &actors[3];
        assert_eq!(
            may(community, plain),
            GroupMay {
                edit: true,
                delete: true,
                change_members: true,
                change_roles: false,
                appoint: false
            }
        );
        assert!(!may(&actors[0], plain).edit);
        assert!(!may(hr, &groups[4]).edit, "a directory group is read-only");
        assert!(!may(hr, &groups[3]).delete, "a role above the actor");
        assert!(may(&actors[5], &groups[3]).delete, "an owner needs no rank");
    }
}
