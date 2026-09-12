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

use super::dto::{MemberUpdatedDto, UpdateProfileRequest, UserProfileDto};
use super::error::ApiError;
use crate::realtime::event::RealtimeEnvelope;

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
///
/// `show_admin` decides whether the instance-administrator badge is carried. It is a setting of the
/// instance: on by default, because an account recovered without a mail relay is recovered by
/// asking an administrator, and turned off by an instance that would rather not point at anyone.
/// Administrators still see each other, so turning it off never leaves them unable to find one
/// another.
fn profile_of(user: users::Model, show_admin: bool) -> UserProfileDto {
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
        is_instance_admin: user.is_instance_admin && show_admin,
        avatar_url,
    }
}

/// Announce a changed identity to everyone who shares a space with the user.
///
/// A display name, a title and a photo are drawn all over the interface, by components that hold a
/// roster loaded when the space opened. Without this the change reaches other people only when they
/// reload, which reads as the picture not having been saved at all. The audience is the co-member
/// set, which already includes the user themselves, so their own other tabs are updated too.
///
/// Best-effort by design: a delivery problem must not fail the write that already succeeded.
pub async fn broadcast_profile_change(state: &AppState, user: &users::Model) {
    let Ok(audience) = super::authz::space_co_members(&state.db, user.id).await else {
        return;
    };
    let payload = MemberUpdatedDto {
        user_id: user.id,
        display_name: user.display_name.clone(),
        title: user.title.clone(),
        is_bot: user.is_bot,
        avatar_url: user
            .avatar_key
            .as_deref()
            .map(|key| crate::files::avatar_url(user.id, key)),
    };
    state
        .hub
        .publish(audience, RealtimeEnvelope::member_updated(&payload))
        .await;
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

    // Administrators are shown to each other whatever the setting says: the setting is about what
    // the instance advertises to its members, not about hiding colleagues from one another.
    let caller_is_admin = session.user_id == user.id && user.is_instance_admin;
    let show_admin = caller_is_admin
        || crate::admin::instance_settings(&state.db)
            .await?
            .show_instance_admins
        || is_instance_admin(&state.db, session.user_id).await?;

    Ok(Json(profile_of(user, show_admin)))
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
    if let Some(timezone) = body.timezone {
        let cleaned = clean(timezone);
        match &cleaned {
            Some(name) if !looks_like_timezone(name) => {
                return Err(ApiError::BadRequest("this does not look like a timezone"));
            }
            _ => active.timezone = Set(cleaned),
        }
    }
    active.updated_at = Set(OffsetDateTime::now_utc());
    let updated = active.update(&state.db).await?;
    broadcast_profile_change(&state, &updated).await;
    // Their own profile: they know whether they administer the instance, so the setting has nothing
    // to hide from them here.
    Ok(Json(profile_of(updated, true)))
}

/// Whether an account administers the instance. Used to decide what a caller is shown, never what
/// they may do; the administration routes check the flag themselves.
async fn is_instance_admin(db: &DatabaseConnection, user_id: Uuid) -> Result<bool, ApiError> {
    Ok(users::Entity::find_by_id(user_id)
        .one(db)
        .await?
        .is_some_and(|user| user.is_instance_admin))
}

/// Whether a string is shaped like an IANA timezone name (`Europe/Paris`, `America/Argentina/Salta`,
/// or a bare `UTC`).
///
/// Shape only, not existence: checking that a zone is real would mean carrying the tz database in
/// the API, and the real list belongs to the client anyway, where the browser already holds it
/// (`Intl.supportedValuesOf("timeZone")`) and offers it as a list to choose from. What this stops is
/// free text landing in a field the interface renders as somebody's working hours.
fn looks_like_timezone(value: &str) -> bool {
    if value.len() > 64 {
        return false;
    }
    let segments: Vec<&str> = value.split('/').collect();
    if segments.is_empty() || segments.len() > 3 {
        return false;
    }
    segments.iter().all(|segment| {
        !segment.is_empty()
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '+')
    })
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
