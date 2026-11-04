//! File-share endpoints: list, create and delete shares.
//!
//! A share is a rule on the file (permissions lot 4): sharing with a person writes a person rule,
//! sharing with a channel writes an audience rule (the readers of that channel), `view` is the
//! "Lire" level and `edit` is "Modifier". The writes go through the very code the Access dialog
//! uses (who may edit, the checks of [`ensure_writable`], the log and the announcement), so a share
//! can never do what the dialog would refuse. Rows of the old `file_shares` table are neither read
//! nor converted: they stay in the table, grant nothing and are not listed.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::{ConnectionTrait, DbBackend, EntityTrait, QueryResult, Statement, TransactionTrait};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{conversations, files, space_members};
use crate::messaging::error::ApiError;
use crate::permissions::catalogue::{Permission, PermissionSet};
use crate::permissions::check::{self, Resource};
use crate::permissions::engine::Standing;
use crate::permissions::levels::{rule_sets, Kind, Level};
use crate::permissions::rule_routes::{resolve, Pick};
use crate::permissions::rules::{
    current_rule, delete_rule, describe, editor_of, ensure_writable, level_name, lock_resource,
    write_rule, Existing, ResourceRef, RuleSubject, Shown,
};
use crate::state::AppState;

use super::authz;
use super::dto::{rfc3339, CreateShareRequest, ShareDto};
use super::error::FileError;

/// The share word of a stored rule: `edit` when it allows editing the content, else `view`.
fn permission_word(allow: PermissionSet) -> &'static str {
    if allow.contains(Permission::FilesEdit) {
        "edit"
    } else {
        "view"
    }
}

/// A share's DTO from a stored rule row (`id, user_id, audience_channel_id, allow, created_by,
/// created_at`).
fn to_dto(file_id: Uuid, row: &QueryResult) -> Result<ShareDto, sea_orm::DbErr> {
    let allow: Vec<String> = row.try_get("", "allow")?;
    Ok(ShareDto {
        id: row.try_get("", "id")?,
        file_id,
        shared_by: row.try_get("", "created_by")?,
        target_user_id: row.try_get("", "user_id")?,
        target_channel_id: row.try_get("", "audience_channel_id")?,
        permission: permission_word(PermissionSet::from_names(&allow)).to_owned(),
        created_at: rfc3339(row.try_get::<OffsetDateTime>("", "created_at")?),
        expires_at: None,
    })
}

/// The file as the lock leaves it: trashed since the first look, it is not shared any more.
async fn still_there(txn: &impl ConnectionTrait, file_id: Uuid) -> Result<(), ApiError> {
    match files::Entity::find_by_id(file_id).one(txn).await? {
        Some(file) if file.deleted_at.is_none() => Ok(()),
        _ => Err(ApiError::NotFound),
    }
}

const SHARE_COLUMNS: &str = "id, user_id, audience_channel_id, allow, deny, created_by, created_at";

/// `GET /api/v1/files/{file_id}/shares`: list a file's shares.
#[utoipa::path(
    get,
    path = "/api/v1/files/{file_id}/shares",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File id")),
    responses(
        (status = 200, description = "The file's shares", body = [ShareDto]),
        (status = 403, description = "No access to the file")
    )
)]
pub async fn list_shares(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
) -> Result<Json<Vec<ShareDto>>, FileError> {
    let access = authz::ensure_readable(&state.db, file_id, session.user_id).await?;

    let rows = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!(
                "SELECT {SHARE_COLUMNS} FROM permission_overrides \
                  WHERE space_id = $2 AND file_id = $1 \
                    AND (user_id IS NOT NULL OR audience_channel_id IS NOT NULL) \
                    AND 'files.view' = ANY(allow) \
                  ORDER BY created_at, id"
            ),
            [file_id.into(), access.file.space_id.into()],
        ))
        .await?;
    // The list shows what the Access dialog would show this reader: a guest only the rows that
    // cover them, and nobody a channel (or its id) they cannot view. The old route has no
    // "hidden" form, so such a row is left out.
    let space_id = access.file.space_id;
    let guest =
        check::standing(&state.db, space_id, session.user_id).await? == Some(Standing::Guest);
    let mut shares = Vec::with_capacity(rows.len());
    for row in &rows {
        let person: Option<Uuid> = row.try_get("", "user_id")?;
        let channel: Option<Uuid> = row.try_get("", "audience_channel_id")?;
        let shown = match (person, channel) {
            (Some(person), _) => !guest || person == session.user_id,
            (None, Some(channel)) => {
                check::can(
                    &state.db,
                    space_id,
                    session.user_id,
                    Resource::Channel(channel),
                    Permission::ChannelView,
                )
                .await?
            }
            (None, None) => false,
        };
        if shown {
            shares.push(to_dto(file_id, row)?);
        }
    }
    Ok(Json(shares))
}

/// `POST /api/v1/files/{file_id}/shares`: share a file with a user or a channel.
#[utoipa::path(
    post,
    path = "/api/v1/files/{file_id}/shares",
    tag = "files",
    params(("file_id" = Uuid, Path, description = "File id")),
    request_body = CreateShareRequest,
    responses(
        (status = 201, description = "Share created", body = ShareDto),
        (status = 200, description = "The target already had a share: it now has the asked level", body = ShareDto),
        (status = 400, description = "Invalid target or permission"),
        (status = 402, description = "`licence_required`"),
        (status = 403, description = "Not allowed to share this file, or `cannot_grant`, `target_above_you`"),
        (status = 409, description = "`licence_frozen`")
    )
)]
pub async fn create_share(
    State(state): State<AppState>,
    session: AuthSession,
    Path(file_id): Path<Uuid>,
    Json(body): Json<CreateShareRequest>,
) -> Result<(StatusCode, Json<ShareDto>), ApiError> {
    let file = files::Entity::find_by_id(file_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::Forbidden)?;
    let space_id = file.space_id;
    let resource = ResourceRef::File(file_id);
    // A cheap refusal first; the decision is taken on the editor as the locked state leaves them.
    editor_of(&state, space_id, session.user_id, resource)
        .await?
        .ok_or(ApiError::Forbidden)?;
    if file.deleted_at.is_some() {
        return Err(ApiError::NotFound);
    }

    let level = match body.permission.as_str() {
        "view" => Level::Read,
        "edit" => Level::Contribute,
        _ => return Err(ApiError::BadRequest("permission must be view or edit")),
    };
    // Exactly one target: user XOR channel.
    let pick = match (body.target_user_id, body.target_channel_id) {
        (Some(user_id), None) => {
            if space_members::Entity::find_by_id((space_id, user_id))
                .one(&state.db)
                .await?
                .is_none()
            {
                return Err(ApiError::BadRequest(
                    "target user is not a member of the space",
                ));
            }
            Pick::User(user_id)
        }
        (None, Some(channel_id)) => {
            let conversation = conversations::Entity::find_by_id(channel_id)
                .one(&state.db)
                .await?
                .ok_or(ApiError::BadRequest("target channel not found"))?;
            if conversation.space_id != space_id || conversation.kind != "channel" {
                return Err(ApiError::BadRequest("invalid target channel"));
            }
            Pick::Audience(channel_id)
        }
        _ => {
            return Err(ApiError::BadRequest(
                "exactly one of target_user_id or target_channel_id is required",
            ));
        }
    };

    let txn = state.db.begin().await?;
    lock_resource(&txn, space_id, resource).await?;
    let editor = editor_of(&state, space_id, session.user_id, resource)
        .await?
        .ok_or(ApiError::Forbidden)?;
    still_there(&txn, file_id).await?;
    let target = resolve(&state, &txn, space_id, session.user_id, pick).await?;
    let class = target.subject.class();
    let (allow, deny) = rule_sets(Kind::File, class, level).map_err(|_| ApiError::Internal)?;
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

    // The old route never lowers: a rule that already allows at least the asked level (and denies
    // nothing) is left as it is, so an older app cannot demote a Gérer or custom rule it lists as
    // "edit". Only a new rule or a raise is written.
    let satisfied = existing.is_some_and(|e| e.deny.is_empty() && allow.minus(e.allow).is_empty());
    let changed = !satisfied && existing.is_none_or(|e| (e.allow, e.deny) != (allow, deny));
    let written = if changed {
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
                    describe(Kind::File, class, r.allow, r.deny)
                }),
                after: serde_json::Value::from(level_name(level)),
            },
        )
        .await?
        .id
    } else {
        stored.map(|r| r.id).ok_or(ApiError::Internal)?
    };
    let row = txn
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!("SELECT {SHARE_COLUMNS} FROM permission_overrides WHERE id = $1"),
            [written.into()],
        ))
        .await?
        .ok_or(ApiError::Internal)?;
    let dto = to_dto(file_id, &row)?;
    txn.commit().await?;
    if changed {
        crate::permissions::changed::announce(&state, space_id).await;
    }
    // A stored rule that was not listed as a share (a pure deny, say) is a new share to the app.
    let listed = stored.is_some_and(|r| r.allow.contains(Permission::FilesView));
    let status = if listed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(dto)))
}

/// `DELETE /api/v1/files/{file_id}/shares/{share_id}`: remove a share.
#[utoipa::path(
    delete,
    path = "/api/v1/files/{file_id}/shares/{share_id}",
    tag = "files",
    params(
        ("file_id" = Uuid, Path, description = "File id"),
        ("share_id" = Uuid, Path, description = "Share id: the id of the rule it is")
    ),
    responses(
        (status = 204, description = "Share removed"),
        (status = 403, description = "Not allowed to modify this file, or `target_above_you`"),
        (status = 404, description = "Share not found (a share of the old table is not one)"),
        (status = 409, description = "`licence_frozen`")
    )
)]
pub async fn delete_share(
    State(state): State<AppState>,
    session: AuthSession,
    Path((file_id, share_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let file = files::Entity::find_by_id(file_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::Forbidden)?;
    let space_id = file.space_id;
    let resource = ResourceRef::File(file_id);
    editor_of(&state, space_id, session.user_id, resource)
        .await?
        .ok_or(ApiError::Forbidden)?;
    if file.deleted_at.is_some() {
        return Err(ApiError::NotFound);
    }

    let txn = state.db.begin().await?;
    lock_resource(&txn, space_id, resource).await?;
    let editor = editor_of(&state, space_id, session.user_id, resource)
        .await?
        .ok_or(ApiError::Forbidden)?;
    still_there(&txn, file_id).await?;
    let row = txn
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!(
                "SELECT {SHARE_COLUMNS} FROM permission_overrides \
                  WHERE id = $1 AND file_id = $2 AND space_id = $3 \
                    AND (user_id IS NOT NULL OR audience_channel_id IS NOT NULL)"
            ),
            [share_id.into(), file_id.into(), space_id.into()],
        ))
        .await?
        .ok_or(ApiError::NotFound)?;
    let user: Option<Uuid> = row.try_get("", "user_id")?;
    let channel: Option<Uuid> = row.try_get("", "audience_channel_id")?;
    let allow: Vec<String> = row.try_get("", "allow")?;
    let deny: Vec<String> = row.try_get("", "deny")?;
    let existing = Existing {
        allow: PermissionSet::from_names(&allow),
        deny: PermissionSet::from_names(&deny),
    };
    let pick = match (user, channel) {
        (Some(user), _) => Pick::User(user),
        (None, Some(channel)) => Pick::Audience(channel),
        (None, None) => return Err(ApiError::NotFound),
    };
    let target = resolve(&state, &txn, space_id, session.user_id, pick).await?;
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
    let subject: RuleSubject = target.subject;
    delete_rule(
        &txn,
        space_id,
        session.user_id,
        resource,
        subject,
        share_id,
        Shown {
            before: describe(Kind::File, subject.class(), existing.allow, existing.deny),
            after: serde_json::Value::Null,
        },
    )
    .await?;
    txn.commit().await?;
    crate::permissions::changed::announce(&state, space_id).await;
    Ok(StatusCode::NO_CONTENT)
}
