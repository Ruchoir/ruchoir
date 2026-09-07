//! Member profile lookup.
//!
//! Backs the profile card and member list: the stable, self-editable fields of a user (title,
//! pronouns, timezone, bio, bot flag). Presence is deliberately not folded in here (it is volatile
//! and sourced from `GET /spaces/{id}/presence` and realtime events). A profile is returned only for
//! a user who shares at least one space with the caller, so an authenticated account cannot
//! enumerate every user on the instance; a disjoint pair is refused with a flat `403` that does not
//! confirm whether the id exists.

use std::collections::BTreeSet;

use axum::extract::{Path, State};
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, IntoActiveModel, QueryFilter,
};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{space_members, users};
use crate::state::AppState;

use super::dto::{UpdateProfileRequest, UserProfileDto};
use super::error::ApiError;

/// Trim a submitted profile string, mapping a blank value to "clear the field".
fn clean(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

/// Build the profile DTO from a user row.
fn profile_of(user: users::Model) -> UserProfileDto {
    let avatar_url = user
        .avatar_key
        .as_deref()
        .map(|key| crate::files::avatar_url(user.id, key));
    UserProfileDto {
        id: user.id,
        display_name: user.display_name,
        email: user.email,
        title: user.title,
        pronouns: user.pronouns,
        timezone: user.timezone,
        bio: user.bio,
        is_bot: user.is_bot,
        avatar_url,
    }
}

/// `GET /api/v1/users/{user_id}`: the profile of a member the caller shares a space with.
#[utoipa::path(
    get,
    path = "/api/v1/users/{user_id}",
    tag = "messaging",
    params(("user_id" = Uuid, Path, description = "User id")),
    responses(
        (status = 200, description = "The member's profile", body = UserProfileDto),
        (status = 403, description = "No shared space with the caller (or no such user)")
    )
)]
pub async fn get_user_profile(
    State(state): State<AppState>,
    session: AuthSession,
    Path(user_id): Path<Uuid>,
) -> Result<Json<UserProfileDto>, ApiError> {
    // A caller can always read their own profile; otherwise they must share a space with the target.
    if user_id != session.user_id && !shares_a_space(&state.db, session.user_id, user_id).await? {
        return Err(ApiError::Forbidden);
    }

    let user = users::Entity::find_by_id(user_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::Forbidden)?;

    Ok(Json(profile_of(user)))
}

/// `PATCH /api/v1/users/me`: update the caller's own profile fields.
#[utoipa::path(
    patch,
    path = "/api/v1/users/me",
    tag = "messaging",
    request_body = UpdateProfileRequest,
    responses((status = 200, description = "The updated profile", body = UserProfileDto))
)]
pub async fn update_my_profile(
    State(state): State<AppState>,
    session: AuthSession,
    Json(body): Json<UpdateProfileRequest>,
) -> Result<Json<UserProfileDto>, ApiError> {
    let user = users::Entity::find_by_id(session.user_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    let mut active = user.into_active_model();
    if let Some(name) = body.display_name {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            active.display_name = Set(trimmed.to_owned());
        }
    }
    if let Some(title) = body.title {
        active.title = Set(clean(title));
    }
    if let Some(pronouns) = body.pronouns {
        active.pronouns = Set(clean(pronouns));
    }
    if let Some(bio) = body.bio {
        active.bio = Set(clean(bio));
    }
    active.updated_at = Set(OffsetDateTime::now_utc());
    let updated = active.update(&state.db).await?;
    Ok(Json(profile_of(updated)))
}

/// Whether two users belong to at least one common space.
async fn shares_a_space(db: &DatabaseConnection, a: Uuid, b: Uuid) -> Result<bool, ApiError> {
    let spaces_of = |user: Uuid| async move {
        Ok::<BTreeSet<Uuid>, ApiError>(
            space_members::Entity::find()
                .filter(space_members::Column::UserId.eq(user))
                .all(db)
                .await?
                .into_iter()
                .map(|m| m.space_id)
                .collect(),
        )
    };
    let a_spaces = spaces_of(a).await?;
    let b_spaces = spaces_of(b).await?;
    Ok(a_spaces.intersection(&b_spaces).next().is_some())
}
