//! Instance administration: the few acts that belong to the instance rather than to a space.
//!
//! Today that is one act, account recovery, and it exists because an instance is allowed to run
//! without a mail relay. Someone who has forgotten their password, and who has no recovery code
//! left either, has no self-service path back in; an administrator hands them one.
//!
//! The guard is `users.is_instance_admin`, not a space role. A space role says what someone may do
//! *inside one space*, while an account is global: letting the administrator of one space reissue
//! access to one of its members would hand them that person's other spaces too.
//!
//! The administrator never learns the password. They trigger a single-use reset link, shown to them
//! once, which they pass on by whatever channel they have (in person, by telephone, by another
//! messenger). The account holder chooses the new password themselves, and the link is the same
//! kind of token the emailed flow uses, with the same lifetime and the same single use.

use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Expr, ExprTrait};
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::auth::tokens::{self, TokenPurpose};
use crate::entities::{instance_settings, users};
use crate::messaging::error::ApiError;
use crate::state::AppState;

/// How many accounts a listing or a search returns.
///
/// The screen shows the instance's accounts outright, because on a self-hosted server there are
/// tens of them and scrolling a list is faster than recalling how a colleague spelled their name.
/// The cap is what keeps that honest on an instance where it is no longer true; past it, the search
/// is the way through.
const LIST_LIMIT: u64 = 100;

/// How long an administrator-issued reset link lives.
///
/// Shorter than the emailed one, which has to survive a mailbox being read later: this one is
/// dictated or pasted into a conversation within minutes, and it grants a password change.
const RESET_TTL_SECS: i64 = 30 * 60;

/// An account, as an administrator sees it while looking for the right one.
#[derive(Debug, Serialize, ToSchema)]
pub struct AdminUserDto {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    /// `pending`, `active` or `locked`.
    pub status: String,
    pub is_instance_admin: bool,
}

/// Search terms for the account lookup.
#[derive(Debug, Deserialize, ToSchema)]
pub struct UserSearchQuery {
    /// Matched against the address and the display name, case-insensitively.
    #[serde(default)]
    pub query: String,
}

/// The instance's settings, as an administrator sees and changes them.
#[derive(Debug, Serialize, ToSchema)]
pub struct InstanceSettingsDto {
    /// Whether the interface tells everyone who administers the instance.
    pub show_instance_admins: bool,
}

/// A change to the instance's settings. Every field is optional: what is absent is left alone.
#[derive(Debug, Deserialize, ToSchema)]
pub struct InstanceSettingsPatch {
    #[serde(default)]
    pub show_instance_admins: Option<bool>,
}

/// A reset link, returned once and never retrievable again.
#[derive(Debug, Serialize, ToSchema)]
pub struct IssuedResetDto {
    /// Absolute link for the account holder to open.
    pub url: String,
    /// How long it stays valid, in seconds.
    pub expires_in_secs: i64,
}

/// The instance-administration routes. Merged into the main router with absolute paths.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/admin/users", get(search_users))
        .route(
            "/api/v1/admin/users/{user_id}/password-reset",
            post(issue_password_reset),
        )
        .route(
            "/api/v1/admin/settings",
            get(read_settings).patch(update_settings),
        )
}

/// Confirm the caller administers this instance.
///
/// Answers `404`, not `403`: to anyone who is not an administrator this surface does not exist,
/// and a refusal that distinguishes "forbidden" from "no such route" would confirm that an
/// administration surface is there to be attacked.
async fn ensure_instance_admin(state: &AppState, user_id: Uuid) -> Result<(), ApiError> {
    let is_admin = users::Entity::find_by_id(user_id)
        .one(&state.db)
        .await?
        .is_some_and(|user| user.is_instance_admin);
    if is_admin {
        Ok(())
    } else {
        Err(ApiError::NotFound)
    }
}

/// `GET /api/v1/admin/users?query=`: find the account to act on.
#[utoipa::path(
    get,
    path = "/api/v1/admin/users",
    tag = "admin",
    params(("query" = String, Query, description = "Part of an address or display name")),
    responses(
        (status = 200, description = "Matching accounts", body = [AdminUserDto]),
        (status = 404, description = "Not an instance administrator")
    )
)]
pub async fn search_users(
    State(state): State<AppState>,
    session: AuthSession,
    Query(params): Query<UserSearchQuery>,
) -> Result<Json<Vec<AdminUserDto>>, ApiError> {
    ensure_instance_admin(&state, session.user_id).await?;

    // The wildcards of LIKE are escaped, so a term containing `%` or `_` searches for those
    // characters instead of matching everything. Matching is case-insensitive (`ILIKE`): someone
    // looking for an account types a name the way they say it, not the way it was entered.
    let needle = params.query.trim();
    let pattern = (!needle.is_empty()).then(|| {
        format!(
            "%{}%",
            needle
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        )
    });

    // With no term this lists the instance's accounts rather than waiting for a name. The surface is
    // administrators-only already, and on a self-hosted server the list is short enough that reading
    // it beats recalling how a colleague spelled theirs.
    let mut query = users::Entity::find().filter(users::Column::IsBot.eq(false));
    if let Some(pattern) = &pattern {
        query = query.filter(
            Expr::col(users::Column::Email)
                .ilike(pattern)
                .or(Expr::col(users::Column::DisplayName).ilike(pattern)),
        );
    }
    let rows = query
        .order_by_asc(users::Column::DisplayName)
        .limit(LIST_LIMIT)
        .all(&state.db)
        .await?;

    Ok(Json(
        rows.into_iter()
            .map(|user| AdminUserDto {
                id: user.id,
                email: user.email,
                display_name: user.display_name,
                status: user.status,
                is_instance_admin: user.is_instance_admin,
            })
            .collect(),
    ))
}

/// `POST /api/v1/admin/users/{user_id}/password-reset`: hand back a way in.
///
/// Nothing about the account changes here: the existing password keeps working until its holder
/// uses the link. That matters when the link never reaches them, or reaches the wrong person.
#[utoipa::path(
    post,
    path = "/api/v1/admin/users/{user_id}/password-reset",
    tag = "admin",
    params(("user_id" = Uuid, Path, description = "Account to issue a link for")),
    responses(
        (status = 200, description = "The single-use link, shown once", body = IssuedResetDto),
        (status = 400, description = "This account has no password to reset"),
        (status = 404, description = "Not an instance administrator, or no such account")
    )
)]
pub async fn issue_password_reset(
    State(state): State<AppState>,
    session: AuthSession,
    Path(user_id): Path<Uuid>,
) -> Result<Json<IssuedResetDto>, ApiError> {
    ensure_instance_admin(&state, session.user_id).await?;

    let user = users::Entity::find_by_id(user_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    if user.password_hash.is_none() {
        return Err(ApiError::BadRequest(
            "this account does not sign in with a password",
        ));
    }

    let token = tokens::issue(
        &state.valkey,
        TokenPurpose::PasswordReset,
        user.id,
        RESET_TTL_SECS,
    )
    .await
    .map_err(|_| ApiError::Internal)?;

    let base = state.mailer.base_url.trim_end_matches('/');
    // The address is not secret to the administrator who just searched for it, but the link is:
    // it is returned in the response body and never written to a log.
    tracing::info!(
        actor = %session.user_id,
        subject = %user.id,
        "instance admin issued a password-reset link"
    );

    Ok(Json(IssuedResetDto {
        url: format!("{base}/reset-password?token={token}"),
        expires_in_secs: RESET_TTL_SECS,
    }))
}

/// Read the instance's settings row.
///
/// The row is seeded by the migration that created the table, so it always exists; a missing row
/// would mean the table was tampered with, and the defaults are the safe answer rather than an
/// error that would take profiles down with it.
pub async fn instance_settings(
    db: &sea_orm::DatabaseConnection,
) -> Result<instance_settings::Model, ApiError> {
    Ok(instance_settings::Entity::find()
        .one(db)
        .await?
        .unwrap_or(instance_settings::Model {
            id: true,
            show_instance_admins: true,
            updated_at: OffsetDateTime::now_utc(),
        }))
}

/// `GET /api/v1/admin/settings`: what the instance is currently set to.
#[utoipa::path(
    get,
    path = "/api/v1/admin/settings",
    tag = "admin",
    responses(
        (status = 200, description = "Current settings", body = InstanceSettingsDto),
        (status = 404, description = "Not an instance administrator")
    )
)]
pub async fn read_settings(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<Json<InstanceSettingsDto>, ApiError> {
    ensure_instance_admin(&state, session.user_id).await?;
    let settings = instance_settings(&state.db).await?;
    Ok(Json(InstanceSettingsDto {
        show_instance_admins: settings.show_instance_admins,
    }))
}

/// `PATCH /api/v1/admin/settings`: change what the instance is set to.
#[utoipa::path(
    patch,
    path = "/api/v1/admin/settings",
    tag = "admin",
    request_body = InstanceSettingsPatch,
    responses(
        (status = 200, description = "Settings after the change", body = InstanceSettingsDto),
        (status = 404, description = "Not an instance administrator")
    )
)]
pub async fn update_settings(
    State(state): State<AppState>,
    session: AuthSession,
    Json(body): Json<InstanceSettingsPatch>,
) -> Result<Json<InstanceSettingsDto>, ApiError> {
    ensure_instance_admin(&state, session.user_id).await?;

    let current = instance_settings(&state.db).await?;
    let Some(show) = body.show_instance_admins else {
        // Nothing asked for, nothing written: a no-op patch must not bump `updated_at`.
        return Ok(Json(InstanceSettingsDto {
            show_instance_admins: current.show_instance_admins,
        }));
    };

    let mut active = current.into_active_model();
    active.show_instance_admins = Set(show);
    active.updated_at = Set(OffsetDateTime::now_utc());
    let saved = active.update(&state.db).await?;

    tracing::info!(
        actor = %session.user_id,
        show_instance_admins = saved.show_instance_admins,
        "instance settings changed"
    );
    Ok(Json(InstanceSettingsDto {
        show_instance_admins: saved.show_instance_admins,
    }))
}
