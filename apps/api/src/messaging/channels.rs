//! Channel lifecycle: create, update (including archiving), join and leave.
//!
//! Reading a channel is governed by [`super::authz`]; this module covers the writes that change the
//! channel itself or the caller's membership of it. The rules mirror the read model:
//!
//! - Any member of the space may create a channel and becomes its owner.
//! - Changing a channel (rename, topic, visibility, archive) requires moderation rights.
//! - A public channel may be joined by any space member; a private one is joined by invitation only,
//!   so it is not joinable here.
//! - Leaving only removes the caller's own membership row.
//!
//! Archiving is a state on the channel (`type = archived`), not a deletion: the history stays
//! readable to the space and the conversation simply stops accepting messages.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, IntoActiveModel, QueryFilter,
    TransactionTrait,
};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{channel_members, channels, conversations};
use crate::state::AppState;

use super::authz::{ensure_space_member, is_channel_moderator};
use super::conversations::unread_count;
use super::dto::{ChannelDto, CreateChannelRequest, UpdateChannelRequest};
use super::error::ApiError;
use super::slug::slugify;

/// `POST /api/v1/spaces/{space_id}/channels`: create a channel, owned by the caller.
#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/channels",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    request_body = CreateChannelRequest,
    responses(
        (status = 201, description = "Channel created", body = ChannelDto),
        (status = 400, description = "Invalid name or type, or the name is taken in this space"),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn create_channel(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Json(body): Json<CreateChannelRequest>,
) -> Result<(StatusCode, Json<ChannelDto>), ApiError> {
    ensure_space_member(&state.db, space_id, session.user_id).await?;

    let name = slugify(&body.name);
    if name.is_empty() {
        return Err(ApiError::BadRequest("this channel name is not usable"));
    }
    // A channel cannot start archived: archiving is something you do to an existing channel.
    let channel_type = match body.channel_type.as_str() {
        "public" => "public",
        "private" => "private",
        _ => {
            return Err(ApiError::BadRequest(
                "a channel is either public or private",
            ))
        }
    };
    if name_is_taken(&state.db, space_id, &name, None).await? {
        return Err(ApiError::BadRequest(
            "a channel with this name already exists in this space",
        ));
    }

    let channel_id = Uuid::new_v4();
    let now = OffsetDateTime::now_utc();
    let topic = body
        .topic
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty());

    let txn = state.db.begin().await?;
    // The conversation row comes first: the channel is its detail table.
    conversations::ActiveModel {
        id: Set(channel_id),
        space_id: Set(space_id),
        kind: Set("channel".to_owned()),
        created_at: Set(now),
    }
    .insert(&txn)
    .await?;
    channels::ActiveModel {
        id: Set(channel_id),
        space_id: Set(space_id),
        name: Set(name.clone()),
        channel_type: Set(channel_type.to_owned()),
        topic: Set(topic.clone()),
        created_by: Set(Some(session.user_id)),
        archived_at: Set(None),
        imported_source: Set(None),
        external_ref: Set(None),
        created_at: Set(now),
    }
    .insert(&txn)
    .await?;
    join_row(&txn, channel_id, session.user_id, "owner", now).await?;
    txn.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(ChannelDto {
            id: channel_id,
            name,
            channel_type: channel_type.to_owned(),
            topic,
            imported: None,
            favorite: false,
            member: true,
            unread: 0,
        }),
    ))
}

/// `PATCH /api/v1/channels/{channel_id}`: rename a channel, set its topic, or change its
/// visibility (including archiving it).
#[utoipa::path(
    patch,
    path = "/api/v1/channels/{channel_id}",
    tag = "messaging",
    params(("channel_id" = Uuid, Path, description = "Channel id")),
    request_body = UpdateChannelRequest,
    responses(
        (status = 200, description = "Channel updated", body = ChannelDto),
        (status = 400, description = "Invalid name or type, or the name is taken in this space"),
        (status = 403, description = "Not allowed to moderate this channel")
    )
)]
pub async fn update_channel(
    State(state): State<AppState>,
    session: AuthSession,
    Path(channel_id): Path<Uuid>,
    Json(body): Json<UpdateChannelRequest>,
) -> Result<Json<ChannelDto>, ApiError> {
    let channel = channels::Entity::find_by_id(channel_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::Forbidden)?;
    ensure_space_member(&state.db, channel.space_id, session.user_id).await?;
    if !is_channel_moderator(&state.db, channel_id, channel.space_id, session.user_id).await? {
        return Err(ApiError::Forbidden);
    }

    let space_id = channel.space_id;
    let imported = channel.imported_source.clone();
    let mut active = channel.clone().into_active_model();

    if let Some(raw_name) = body.name {
        let name = slugify(&raw_name);
        if name.is_empty() {
            return Err(ApiError::BadRequest("this channel name is not usable"));
        }
        if name != channel.name
            && name_is_taken(&state.db, space_id, &name, Some(channel_id)).await?
        {
            return Err(ApiError::BadRequest(
                "a channel with this name already exists in this space",
            ));
        }
        active.name = Set(name);
    }
    if let Some(topic) = body.topic {
        // An empty topic clears it, the same convention the profile endpoint uses.
        let topic = topic.trim().to_owned();
        active.topic = Set((!topic.is_empty()).then_some(topic));
    }
    if let Some(channel_type) = body.channel_type {
        match channel_type.as_str() {
            "archived" => {
                active.channel_type = Set("archived".to_owned());
                active.archived_at = Set(Some(OffsetDateTime::now_utc()));
            }
            visible @ ("public" | "private") => {
                active.channel_type = Set(visible.to_owned());
                // Restoring a channel clears the archive stamp, so it reads as live again.
                active.archived_at = Set(None);
            }
            _ => {
                return Err(ApiError::BadRequest(
                    "a channel is public, private or archived",
                ))
            }
        }
    }

    let updated = active.update(&state.db).await?;
    let membership = channel_members::Entity::find_by_id((channel_id, session.user_id))
        .one(&state.db)
        .await?;
    Ok(Json(ChannelDto {
        id: updated.id,
        name: updated.name,
        channel_type: updated.channel_type,
        topic: updated.topic,
        imported,
        favorite: membership.as_ref().is_some_and(|m| m.favorite),
        member: membership.is_some(),
        unread: unread_count(&state.db, channel_id, session.user_id).await?,
    }))
}

/// `PUT /api/v1/channels/{channel_id}/membership`: join a public channel. Idempotent.
#[utoipa::path(
    put,
    path = "/api/v1/channels/{channel_id}/membership",
    tag = "messaging",
    params(("channel_id" = Uuid, Path, description = "Channel id")),
    responses(
        (status = 204, description = "Joined (or already a member)"),
        (status = 400, description = "The channel is archived"),
        (status = 403, description = "Not a member of the space, or the channel is private")
    )
)]
pub async fn join_channel(
    State(state): State<AppState>,
    session: AuthSession,
    Path(channel_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let channel = channels::Entity::find_by_id(channel_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::Forbidden)?;
    ensure_space_member(&state.db, channel.space_id, session.user_id).await?;
    // A private channel is joined by invitation, which is not this endpoint. The 403 is the same
    // one a non-member gets when reading it, so nothing is revealed either way.
    if channel.channel_type == "private" {
        return Err(ApiError::Forbidden);
    }
    if channel.channel_type == "archived" {
        return Err(ApiError::BadRequest("this channel is archived"));
    }

    if channel_members::Entity::find_by_id((channel_id, session.user_id))
        .one(&state.db)
        .await?
        .is_none()
    {
        join_row(
            &state.db,
            channel_id,
            session.user_id,
            "member",
            OffsetDateTime::now_utc(),
        )
        .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/v1/channels/{channel_id}/membership`: leave a channel. Idempotent.
///
/// Only the caller's own membership goes: the channel, its history and its other members are
/// untouched. Leaving a private channel means losing access to it.
#[utoipa::path(
    delete,
    path = "/api/v1/channels/{channel_id}/membership",
    tag = "messaging",
    params(("channel_id" = Uuid, Path, description = "Channel id")),
    responses(
        (status = 204, description = "Left (or was not a member)"),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn leave_channel(
    State(state): State<AppState>,
    session: AuthSession,
    Path(channel_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let channel = channels::Entity::find_by_id(channel_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::Forbidden)?;
    ensure_space_member(&state.db, channel.space_id, session.user_id).await?;

    channel_members::Entity::delete_by_id((channel_id, session.user_id))
        .exec(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Insert a membership row with the given role and the default notification settings.
async fn join_row<C: ConnectionTrait>(
    db: &C,
    channel_id: Uuid,
    user_id: Uuid,
    role: &str,
    now: OffsetDateTime,
) -> Result<(), ApiError> {
    channel_members::ActiveModel {
        channel_id: Set(channel_id),
        user_id: Set(user_id),
        role: Set(role.to_owned()),
        notification_level: Set("all".to_owned()),
        muted: Set(false),
        favorite: Set(false),
        joined_at: Set(now),
    }
    .insert(db)
    .await?;
    Ok(())
}

/// Whether another channel in the space already carries this name. `exclude` skips the channel
/// being renamed, so saving a channel under its own name is not a conflict.
async fn name_is_taken<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    name: &str,
    exclude: Option<Uuid>,
) -> Result<bool, ApiError> {
    let mut query = channels::Entity::find()
        .filter(channels::Column::SpaceId.eq(space_id))
        .filter(channels::Column::Name.eq(name));
    if let Some(id) = exclude {
        query = query.filter(channels::Column::Id.ne(id));
    }
    Ok(query.one(db).await?.is_some())
}
