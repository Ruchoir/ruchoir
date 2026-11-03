//! A space's roles as the API shows them, and the roles of its members.
//!
//! `GET /api/v1/spaces/{space_id}/roles` lists them strongest first, for anyone who reads the
//! member directory (`members.view`: members, not guests), each with what it grants, how many hold
//! it, and whether the caller may manage it (rule 1 of `delegation`). The member list carries each
//! person's role ids and whether the caller may act on them (rule 3), from [`MemberRoles`], loaded
//! for a whole space in three queries.
//!
//! Composing roles (creating, editing, ordering, handing them out) is the enterprise edition's; the
//! names and colours it may use are checked here, so every build says the same.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use sea_orm::{ConnectionTrait, DbBackend, DbErr, Statement};
use serde::Serialize;
use utoipa::ToSchema;
use uuid::Uuid;

use super::catalogue::{Permission, PermissionSet};
use super::check::Resource;
use super::delegation::{rank_of, Rank};
use crate::auth::extract::AuthSession;
use crate::messaging::error::ApiError;
use crate::state::AppState;

/// The design system's pastels, by name: what a role's colour may be.
pub const ROLE_COLOURS: [&str; 7] = ["sky", "mint", "violet", "pink", "peach", "lime", "sun"];

/// Names a custom role may not take: the system roles', in every language the product speaks.
const RESERVED_NAMES: [&str; 5] = [
    "administrator",
    "administrateur",
    "administrador",
    "amministratore",
    "@members",
];

/// A custom role's name, trimmed: 1 to 40 characters, not starting with `@` (the base roles'
/// mark), not a system role's name in any language (`role_name_reserved`).
pub fn validate_role_name(name: &str) -> Result<String, ApiError> {
    let name = name.trim();
    let length = name.chars().count();
    if length == 0 || length > 40 {
        return Err(ApiError::BadRequest("a role's name has 1 to 40 characters"));
    }
    let lower = name.to_lowercase();
    if lower.starts_with('@') || RESERVED_NAMES.contains(&lower.as_str()) {
        return Err(ApiError::ForbiddenBecause("role_name_reserved"));
    }
    Ok(name.to_owned())
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/spaces/{space_id}/roles", get(list_roles))
}

/// One role of the space.
#[derive(Debug, Serialize, ToSchema)]
pub struct RoleDto {
    pub id: Uuid,
    /// `administrator`, `members` or `guests` for a system role (its name is the client's to
    /// translate); absent for the space's own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_key: Option<String>,
    pub name: String,
    /// One of the design system's pastels (`sky`, `mint`, `violet`, `pink`, `peach`, `lime`,
    /// `sun`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colour: Option<String>,
    /// Strongest first: a higher position outranks a lower one.
    pub position: i32,
    /// What it grants, as permission names in catalogue order (unknown names left out).
    pub permissions: Vec<String>,
    /// How many hold it: its assignments, or for a base role the people of that standing.
    pub holders: i64,
    /// Whether the caller may manage it (rule 1: `roles.manage`, and the role below their rank).
    pub manageable: bool,
}

#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/roles",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "The space's roles, strongest first", body = [RoleDto]),
        (status = 403, description = "Not someone who reads this space's member directory")
    )
)]
pub async fn list_roles(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Json<Vec<RoleDto>>, ApiError> {
    let rights = super::check::space_rights(&state.db, space_id, session.user_id).await?;
    if !rights.contains(Permission::MembersView) {
        return Err(ApiError::Forbidden);
    }
    let rank = rank_of(&state.db, space_id, session.user_id)
        .await?
        .ok_or(ApiError::Forbidden)?;
    let manages = rights.contains(Permission::RolesManage);
    let rows = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT r.id, r.system_key, r.name::text AS name, r.colour, r.position, r.permissions, \
                    (CASE r.system_key \
                        WHEN 'members' THEN (SELECT count(*) FROM space_members m \
                                              WHERE m.space_id = r.space_id \
                                                AND m.standing IN ('owner', 'member')) \
                        WHEN 'guests' THEN (SELECT count(*) FROM space_members m \
                                             WHERE m.space_id = r.space_id AND m.standing = 'guest') \
                        ELSE (SELECT count(*) FROM space_role_assignments a WHERE a.role_id = r.id) \
                     END)::bigint AS holders \
               FROM space_roles r WHERE r.space_id = $1 \
              ORDER BY r.position DESC, r.name",
            [space_id.into()],
        ))
        .await?;
    let mut roles = Vec::with_capacity(rows.len());
    for row in rows {
        let position: i32 = row.try_get("", "position")?;
        roles.push(RoleDto {
            id: row.try_get("", "id")?,
            system_key: row.try_get("", "system_key")?,
            name: row.try_get("", "name")?,
            colour: row.try_get("", "colour")?,
            position,
            permissions: PermissionSet::from_names(&row.try_get::<Vec<String>>("", "permissions")?)
                .to_names(),
            holders: row.try_get("", "holders")?,
            manageable: manages && rank.outranks_position(position),
        });
    }
    Ok(Json(roles))
}

/// Every member's assigned roles and rank in one space, and what a viewer may do about them.
pub struct MemberRoles {
    roles: HashMap<Uuid, Vec<Uuid>>,
    ranks: HashMap<Uuid, Rank>,
    viewer: Uuid,
    viewer_rank: Option<Rank>,
    viewer_manages: bool,
}

impl MemberRoles {
    /// Loaded for `space_id` as `viewer` sees it: three queries (roles, assignments, standings)
    /// and the viewer's rights.
    pub async fn load(
        db: &sea_orm::DatabaseConnection,
        space_id: Uuid,
        viewer: Uuid,
    ) -> Result<Self, DbErr> {
        let positions: HashMap<Uuid, (i32, Option<String>)> = db
            .query_all_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT id, position, system_key FROM space_roles WHERE space_id = $1",
                [space_id.into()],
            ))
            .await?
            .into_iter()
            .map(|row| {
                Ok((
                    row.try_get::<Uuid>("", "id")?,
                    (
                        row.try_get::<i32>("", "position")?,
                        row.try_get::<Option<String>>("", "system_key")?,
                    ),
                ))
            })
            .collect::<Result<_, DbErr>>()?;
        let base = |key: &str, fallback: i32| {
            positions
                .values()
                .find(|(_, system)| system.as_deref() == Some(key))
                .map_or(fallback, |(position, _)| *position)
        };
        let (members_base, guests_base) = (base("members", 0), base("guests", -1));
        let mut roles: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
        for row in db
            .query_all_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT a.user_id, a.role_id FROM space_role_assignments a \
                   JOIN space_roles r ON r.id = a.role_id \
                  WHERE a.space_id = $1 ORDER BY r.position DESC",
                [space_id.into()],
            ))
            .await?
        {
            roles
                .entry(row.try_get("", "user_id")?)
                .or_default()
                .push(row.try_get("", "role_id")?);
        }
        let mut ranks = HashMap::new();
        for row in db
            .query_all_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT user_id, standing FROM space_members WHERE space_id = $1",
                [space_id.into()],
            ))
            .await?
        {
            let user: Uuid = row.try_get("", "user_id")?;
            let standing: String = row.try_get("", "standing")?;
            let rank = if standing == "owner" {
                Rank::Owner
            } else {
                let floor = if standing == "guest" {
                    guests_base
                } else {
                    members_base
                };
                let held = roles
                    .get(&user)
                    .into_iter()
                    .flatten()
                    .filter_map(|role| positions.get(role).map(|(position, _)| *position))
                    .max();
                Rank::Position(held.map_or(floor, |held| held.max(floor)))
            };
            ranks.insert(user, rank);
        }
        let rights = super::check::effective(db, space_id, viewer, Resource::Space).await?;
        Ok(MemberRoles {
            viewer_rank: ranks.get(&viewer).copied(),
            viewer_manages: rights.contains(Permission::MembersManage)
                || rights.contains(Permission::RolesManage),
            roles,
            ranks,
            viewer,
        })
    }

    /// The roles assigned to `user` (Administrator included, base roles never), strongest first.
    pub fn role_ids(&self, user: Uuid) -> Vec<Uuid> {
        self.roles.get(&user).cloned().unwrap_or_default()
    }

    /// Whether the viewer may act on `user` (rule 3, and `members.manage` or `roles.manage`).
    pub fn manageable(&self, user: Uuid) -> bool {
        match (self.viewer_rank, self.ranks.get(&user)) {
            (Some(viewer), Some(target)) => {
                self.viewer_manages && user != self.viewer && viewer.outranks(*target)
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::validate_role_name;

    #[test]
    fn reserved_role_names_are_refused() {
        for name in [
            "Administrator",
            " administrateur ",
            "ADMINISTRADOR",
            "Amministratore",
            "@members",
            "@invités",
            "@x",
        ] {
            assert!(validate_role_name(name).is_err(), "{name}");
        }
        for name in ["", "   ", &"x".repeat(41)] {
            assert!(validate_role_name(name).is_err(), "{name:?}");
        }
        assert_eq!(
            validate_role_name("  Comptable ").expect("fine"),
            "Comptable"
        );
        assert_eq!(
            validate_role_name("Administratrice RH").expect("fine"),
            "Administratrice RH"
        );
    }
}
