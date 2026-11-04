//! A guest's end date after they joined, over HTTP: set, move or remove it, list the accesses that
//! ended, and bring one back.
//!
//! All of it is the business of whoever may manage the person: `members.manage` and the delegation
//! rule 3 (they rank strictly above the guest), so a guest never touches their own date and a
//! member without the right touches nobody's. A member has no end date at all (`400 guest_only`).
//!
//! A date arrives as `YYYY-MM-DD`, read as the END of that day (23:59:59) in the time zone of the
//! person who sets it, so the screen, the reminder mail and the cutoff name the same day; or as a
//! full RFC 3339 instant, kept as it is. Either must lie ahead, within five years.
//!
//! Every write moves the reminders back to the start ([`guest_expiry::restart`]), is audited
//! (`member.expiry_set`, `member.reactivated`, each with `before` and `after`) and announced
//! (`permissions.changed`), in that order, after the commit.

use axum::extract::{Path, State};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, DbErr, EntityTrait, QueryFilter, Statement,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use time::{Date, Duration, OffsetDateTime};
use utoipa::ToSchema;
use uuid::Uuid;

use super::catalogue::Permission;
use super::check::Resource;
use super::membership::{self, active_sql};
use super::{changed, delegation, guest_expiry};
use crate::audit::{record, Action, Target};
use crate::auth::extract::AuthSession;
use crate::calendar::recurrence;
use crate::calendar::reminders::reader_time_zone;
use crate::entities::users;
use crate::messaging::dto::{rfc3339, MemberDto};
use crate::messaging::error::ApiError;
use crate::state::AppState;

/// How far ahead an end date may lie, in years: further is a typo, or not a temporary access.
pub const MAX_YEARS: i32 = 5;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/spaces/{space_id}/members/ended", get(list_ended))
        .route(
            "/api/v1/spaces/{space_id}/members/{user_id}/expiry",
            put(set_expiry),
        )
        .route(
            "/api/v1/spaces/{space_id}/members/{user_id}/reactivate",
            post(reactivate),
        )
}

/// The end of a guest's access: a date, an instant, or `null` for no end.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ExpiryRequest {
    /// `YYYY-MM-DD` (the end of that day in the time zone of whoever sets it) or an RFC 3339 instant; `null`
    /// (or absent) for no end.
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// A guest whose access ended and whose row is still kept.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EndedDto {
    pub user_id: Uuid,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// When the access ended (RFC 3339).
    pub ended_at: String,
    /// Whole days left before the row is removed for good (the access can be reactivated until
    /// then).
    pub days_left_to_keep: i64,
}

pub fn bad_expiry() -> ApiError {
    ApiError::BadRequestCode {
        code: "bad_expiry",
        message: "the end date must be a date in the future, within five years",
    }
}

fn guest_only() -> ApiError {
    ApiError::BadRequestCode {
        code: "guest_only",
        message: "only a guest can have an end date",
    }
}

/// `end` lies ahead of `now` and within [`MAX_YEARS`] years.
pub fn ensure_in_range(end: OffsetDateTime, now: OffsetDateTime) -> Result<(), ApiError> {
    // Five calendar years; from 29 February, where that year has no such day, 1826 days.
    let furthest = now
        .replace_year(now.year() + MAX_YEARS)
        .unwrap_or(now + Duration::days(1826));
    if end <= now || end > furthest {
        return Err(bad_expiry());
    }
    Ok(())
}

/// The instant `raw` names, read in `zone` when it is a bare date; `400 bad_expiry` when it is
/// neither a date nor an instant, or lies behind `now` or beyond five years.
pub fn parse_end(raw: &str, now: OffsetDateTime, zone: &str) -> Result<OffsetDateTime, ApiError> {
    let raw = raw.trim();
    let format = time::macros::format_description!("[year]-[month]-[day]");
    let end = if raw.len() == 10 {
        let date = Date::parse(raw, &format).map_err(|_| bad_expiry())?;
        recurrence::local_instant(date, 23, 59, 59, zone).ok_or_else(bad_expiry)?
    } else {
        OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)
            .map_err(|_| bad_expiry())?
    };
    ensure_in_range(end, now)?;
    Ok(end)
}

/// The time zone `user` reads dates in: their profile's, or the instance's fallback.
pub async fn zone_of<C: ConnectionTrait>(db: &C, user: Uuid) -> Result<String, DbErr> {
    let user = users::Entity::find_by_id(user).one(db).await?;
    Ok(reader_time_zone(user.as_ref()))
}

/// The caller may manage `target`, whom this answers whatever their access (active or ended):
/// `403` when the caller is not in the space, lacks `members.manage` or does not outrank them,
/// `404` when `target` is not in the space at all.
async fn manageable_target(
    state: &AppState,
    space_id: Uuid,
    actor: Uuid,
    target: Uuid,
) -> Result<membership::Membership, ApiError> {
    membership::active(&state.db, space_id, actor)
        .await?
        .ok_or(ApiError::Forbidden)?;
    crate::messaging::authz::ensure_permission(
        &state.db,
        space_id,
        actor,
        Resource::Space,
        Permission::MembersManage,
    )
    .await?;
    delegation::ensure_acts_on(&state.db, space_id, actor, target).await?;
    membership::any(&state.db, space_id, target)
        .await?
        .ok_or(ApiError::NotFound)
}

/// Write a guest's end inside `db` (a transaction), and start their reminders over. `false` when
/// the row is not an active guest any more: the caller refuses, the write did not happen.
pub async fn write_end<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    user_id: Uuid,
    end: Option<OffsetDateTime>,
) -> Result<bool, DbErr> {
    let updated = db
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!(
                "UPDATE space_members m SET expires_at = $3 \
                 WHERE m.space_id = $1 AND m.user_id = $2 AND m.standing = 'guest' AND {}",
                active_sql!()
            ),
            [space_id.into(), user_id.into(), end.into()],
        ))
        .await?
        .rows_affected();
    if updated == 0 {
        return Ok(false);
    }
    guest_expiry::restart(db, space_id, user_id).await?;
    Ok(true)
}

/// The audit entry of an end set, moved or removed.
pub async fn audit_end<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    actor: Uuid,
    user_id: Uuid,
    before: Option<OffsetDateTime>,
    after: Option<OffsetDateTime>,
) -> Result<(), DbErr> {
    record(
        db,
        space_id,
        Some(actor),
        Action::MemberExpirySet,
        Target::Member(user_id),
        serde_json::json!({ "before": before.map(rfc3339), "after": after.map(rfc3339) }),
    )
    .await
}

/// The person as the answer of a write shows them.
async fn member_after(
    state: &AppState,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<MemberDto, ApiError> {
    let row = membership::any(&state.db, space_id, user_id)
        .await?
        .ok_or(ApiError::NotFound)?
        .model;
    let user = users::Entity::find_by_id(user_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(MemberDto {
        user_id,
        display_name: user.display_name.clone(),
        title: user.title.clone(),
        role: row.role,
        is_bot: user.is_bot,
        avatar_url: user
            .avatar_key
            .as_deref()
            .map(|key| crate::files::avatar_url(user.id, key)),
        role_ids: None,
        group_ids: None,
        manageable: Some(true),
        joined_at: Some(rfc3339(row.joined_at)),
        standing: Some(row.standing),
        expires_at: row.expires_at.map(rfc3339),
        imported_from: row.imported_from,
    })
}

/// `PUT /api/v1/spaces/{space_id}/members/{user_id}/expiry`: set, move or remove a guest's end
/// date.
#[utoipa::path(
    put,
    path = "/api/v1/spaces/{space_id}/members/{user_id}/expiry",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("user_id" = Uuid, Path, description = "The guest")
    ),
    request_body = ExpiryRequest,
    responses(
        (status = 200, description = "The guest, with their new end", body = MemberDto),
        (status = 400, description = "`bad_expiry`: not a date ahead within five years; `guest_only`: the person is not a guest"),
        (status = 403, description = "Not allowed to manage this person"),
        (status = 404, description = "Not in this space"),
        (status = 409, description = "`access_ended`: the access already ended, reactivate it instead")
    )
)]
pub async fn set_expiry(
    State(state): State<AppState>,
    session: AuthSession,
    Path((space_id, user_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ExpiryRequest>,
) -> Result<Json<MemberDto>, ApiError> {
    let target = manageable_target(&state, space_id, session.user_id, user_id).await?;
    if target.model.standing != "guest" {
        return Err(guest_only());
    }
    if target.ended {
        return Err(ApiError::ConflictCode {
            code: "access_ended",
            message: "this access has ended: reactivate it to give it a new end",
        });
    }
    let end = match body.expires_at.as_deref() {
        Some(raw) => {
            let zone = zone_of(&state.db, session.user_id).await?;
            Some(parse_end(raw, OffsetDateTime::now_utc(), &zone)?)
        }
        None => None,
    };

    let txn = state.db.begin().await?;
    if !write_end(&txn, space_id, user_id, end).await? {
        return Err(ApiError::ConflictCode {
            code: "access_ended",
            message: "this access has ended: reactivate it to give it a new end",
        });
    }
    audit_end(
        &txn,
        space_id,
        session.user_id,
        user_id,
        target.model.expires_at,
        end,
    )
    .await?;
    txn.commit().await?;

    changed::announce(&state, space_id).await;
    Ok(Json(member_after(&state, space_id, user_id).await?))
}

/// `POST /api/v1/spaces/{space_id}/members/{user_id}/reactivate`: bring an ended guest back, with a
/// new end date or none. Their channels, groups and roles were never taken away.
#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/members/{user_id}/reactivate",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("user_id" = Uuid, Path, description = "The guest whose access ended")
    ),
    request_body = ExpiryRequest,
    responses(
        (status = 200, description = "The guest, back in the space", body = MemberDto),
        (status = 400, description = "`bad_expiry`: not a date ahead within five years"),
        (status = 403, description = "Not allowed to manage this person"),
        (status = 404, description = "Not in this space"),
        (status = 409, description = "`not_ended`: the person is not a guest whose access ended; `access_ended_for_good`: it ended more than ninety days ago")
    )
)]
pub async fn reactivate(
    State(state): State<AppState>,
    session: AuthSession,
    Path((space_id, user_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ExpiryRequest>,
) -> Result<Json<MemberDto>, ApiError> {
    let not_ended = || ApiError::ConflictCode {
        code: "not_ended",
        message: "this person's access has not ended",
    };
    let target = manageable_target(&state, space_id, session.user_id, user_id).await?;
    if target.model.standing != "guest" || !target.ended {
        return Err(not_ended());
    }
    // Past the keeping window the list no longer offers the access, and the sweep removes it.
    if target
        .model
        .expires_at
        .is_some_and(|ended| ended + guest_expiry::keep() <= OffsetDateTime::now_utc())
    {
        return Err(ApiError::ConflictCode {
            code: "access_ended_for_good",
            message: "this access ended too long ago to be reactivated",
        });
    }
    let end = match body.expires_at.as_deref() {
        Some(raw) => {
            let zone = zone_of(&state.db, session.user_id).await?;
            Some(parse_end(raw, OffsetDateTime::now_utc(), &zone)?)
        }
        None => None,
    };

    let txn = state.db.begin().await?;
    // Only a guest whose end has passed: someone else's reactivation, or a date moved forward in
    // between, leaves nothing to do.
    let updated = txn
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE space_members SET expires_at = $3 \
             WHERE space_id = $1 AND user_id = $2 AND standing = 'guest' \
               AND expires_at IS NOT NULL AND expires_at <= now()",
            [space_id.into(), user_id.into(), end.into()],
        ))
        .await?
        .rows_affected();
    if updated == 0 {
        return Err(not_ended());
    }
    guest_expiry::restart(&txn, space_id, user_id).await?;
    record(
        &txn,
        space_id,
        Some(session.user_id),
        Action::MemberReactivated,
        Target::Member(user_id),
        serde_json::json!({
            "before": target.model.expires_at.map(rfc3339),
            "after": end.map(rfc3339),
        }),
    )
    .await?;
    txn.commit().await?;

    changed::announce(&state, space_id).await;
    Ok(Json(member_after(&state, space_id, user_id).await?))
}

/// `GET /api/v1/spaces/{space_id}/members/ended`: the guests whose access ended and who are still
/// kept (ninety days), the ones that will be removed first at the top.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/members/ended",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "Ended accesses, soonest removal first", body = [EndedDto]),
        (status = 403, description = "Not allowed to manage the space's people")
    )
)]
pub async fn list_ended(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Json<Vec<EndedDto>>, ApiError> {
    membership::active(&state.db, space_id, session.user_id)
        .await?
        .ok_or(ApiError::Forbidden)?;
    crate::messaging::authz::ensure_permission(
        &state.db,
        space_id,
        session.user_id,
        Resource::Space,
        Permission::MembersManage,
    )
    .await?;
    let rows = membership::ended(&state.db, space_id).await?;
    let people: std::collections::HashMap<Uuid, users::Model> = users::Entity::find()
        .filter(users::Column::Id.is_in(rows.iter().map(|r| r.user_id).collect::<Vec<_>>()))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|u| (u.id, u))
        .collect();
    let now = OffsetDateTime::now_utc();
    let keep = guest_expiry::keep();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let (Some(ended_at), Some(user)) = (row.expires_at, people.get(&row.user_id)) else {
            continue;
        };
        let left = ended_at + keep - now;
        if left <= Duration::ZERO {
            // Due for removal by the next sweep: not offered any more.
            continue;
        }
        out.push(EndedDto {
            user_id: row.user_id,
            display_name: user.display_name.clone(),
            title: user.title.clone(),
            ended_at: rfc3339(ended_at),
            days_left_to_keep: (left.whole_seconds() + 86_399) / 86_400,
        });
    }
    Ok(Json(out))
}
