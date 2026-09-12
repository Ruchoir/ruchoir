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
use crate::entities::{channel_members, channels, conversations, messages, users};
use crate::state::AppState;
use sea_orm::DatabaseConnection;

use super::authz::{ensure_space_member, is_channel_moderator, space_member_ids};
use super::conversations::unread_count;
use super::dto::{
    AddChannelMembersRequest, AddedMembersDto, ChannelDto, ChannelSummaryDto, CreateChannelRequest,
    FavoriteRequest, MemberDto, UpdateChannelRequest,
};
use super::error::ApiError;
use super::slug::slugify;
use crate::realtime::event::RealtimeEnvelope;

/// The `system_event` discriminators written into a channel's own history. The client turns each
/// into a sentence; the database stores the event and never the words, like everywhere else.
///
/// These existed in the client from the start (six languages, an icon, a renderer) and **nothing on
/// the server ever wrote them**: joining or leaving a channel left no trace, and only the seed
/// announced a creation, so every demonstration channel said it had been created and every real one
/// stayed silent about it.
const CREATED_EVENT: &str = "channel_created";
const JOINED_EVENT: &str = "channel_joined";
const LEFT_EVENT: &str = "channel_left";

/// Write a system notice into a channel and push it to the people in it.
///
/// `subject` is the person the notice is about, which is what lets the client name them without a
/// second lookup; `None` for a notice about nobody in particular, such as the channel's creation.
/// Best-effort in spirit but not in error handling: it runs after the write it describes, and a
/// failure here is a missing line in a history, never a failed request, so callers log rather than
/// propagate.
async fn write_channel_notice(
    state: &AppState,
    channel_id: Uuid,
    subject: Option<Uuid>,
    event: &str,
) {
    let notice = messages::ActiveModel {
        id: Set(Uuid::new_v4()),
        conversation_id: Set(channel_id),
        author_id: Set(subject),
        kind: Set("system".to_owned()),
        system_event: Set(Some(event.to_owned())),
        created_at: Set(OffsetDateTime::now_utc()),
        ..Default::default()
    }
    .insert(&state.db)
    .await;
    let notice = match notice {
        Ok(notice) => notice,
        Err(error) => {
            tracing::warn!(%error, "could not write a channel notice");
            return;
        }
    };
    let Ok(members) = channel_members::Entity::find()
        .filter(channel_members::Column::ChannelId.eq(channel_id))
        .all(&state.db)
        .await
    else {
        return;
    };
    let audience: Vec<Uuid> = members.into_iter().map(|m| m.user_id).collect();
    if audience.is_empty() {
        return;
    }
    // Hydrated for whoever wrote it; the per-caller fields a system notice carries are all false.
    if let Ok(Some(dto)) = super::messages::hydrate_messages(
        &state.db,
        subject.unwrap_or_else(Uuid::nil),
        vec![notice],
    )
    .await
    .map(|mut rows| rows.pop())
    {
        state
            .hub
            .publish(audience, RealtimeEnvelope::message_created(channel_id, dto))
            .await;
    }
}

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
    // A guest is in the space to take part in what they were brought into, not to open new rooms in
    // an organisation that is not theirs.
    if super::authz::is_guest(&state.db, space_id, session.user_id).await? {
        return Err(ApiError::Forbidden);
    }

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

    // Tell the space (or, for a private channel, only its members) that the channel exists, so the
    // sidebar gains it without a reload.
    let summary = ChannelSummaryDto {
        id: channel_id,
        space_id,
        name: name.clone(),
        channel_type: channel_type.to_owned(),
        topic: topic.clone(),
    };
    let audience = channel_audience(
        &state.db,
        space_id,
        channel_id,
        channel_type,
        session.user_id,
    )
    .await?;
    state
        .hub
        .publish(
            audience,
            RealtimeEnvelope::channel_created(channel_id, &summary),
        )
        .await;
    // The channel's own history says it was created, the way every seeded channel already did and
    // no real one ever did.
    write_channel_notice(&state, channel_id, None, CREATED_EVENT).await;

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

    // Every member of the space is told, whatever the new visibility: a channel turned private has
    // to leave the sidebar of those who are not in it, and they can only learn that from this event.
    // The payload carries no per-caller state, so nothing private about a member leaks with it.
    let summary = ChannelSummaryDto {
        id: updated.id,
        space_id,
        name: updated.name.clone(),
        channel_type: updated.channel_type.clone(),
        topic: updated.topic.clone(),
    };
    let audience = space_member_ids(&state.db, space_id, session.user_id).await?;
    state
        .hub
        .publish(
            audience,
            RealtimeEnvelope::channel_updated(channel_id, &summary),
        )
        .await;

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
    // one a non-member gets when reading it, so nothing is revealed either way. A guest is refused
    // for the same reason on any channel: every room they are in, somebody put them in.
    if channel.channel_type == "private"
        || super::authz::is_guest(&state.db, channel.space_id, session.user_id).await?
    {
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
        // Only on a real arrival: re-pressing "join" on a channel you are already in announces
        // nothing, the same rule the space invitation follows.
        write_channel_notice(&state, channel_id, Some(session.user_id), JOINED_EVENT).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/channels/{channel_id}/members`: who is actually in this channel.
///
/// The member panel and the add-people dialog both showed the members of the *space* instead, which
/// is a different set the moment a channel is private or anyone leaves one. Roles are the channel's
/// own (`owner`, `admin`, `member`), not the space's.
#[utoipa::path(
    get,
    path = "/api/v1/channels/{channel_id}/members",
    tag = "messaging",
    params(("channel_id" = Uuid, Path, description = "Channel id")),
    responses(
        (status = 200, description = "Channel members, by name", body = [MemberDto]),
        (status = 403, description = "Not allowed to see this channel")
    )
)]
pub async fn list_channel_members(
    State(state): State<AppState>,
    session: AuthSession,
    Path(channel_id): Path<Uuid>,
) -> Result<Json<Vec<MemberDto>>, ApiError> {
    let channel = channels::Entity::find_by_id(channel_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::Forbidden)?;
    ensure_space_member(&state.db, channel.space_id, session.user_id).await?;
    // A private channel does not list its people to someone outside it: its membership is as private
    // as its messages.
    if channel.channel_type == "private"
        && channel_members::Entity::find_by_id((channel_id, session.user_id))
            .one(&state.db)
            .await?
            .is_none()
    {
        return Err(ApiError::Forbidden);
    }

    let memberships = channel_members::Entity::find()
        .filter(channel_members::Column::ChannelId.eq(channel_id))
        .all(&state.db)
        .await?;
    let ids: Vec<Uuid> = memberships.iter().map(|m| m.user_id).collect();
    let by_id: std::collections::HashMap<Uuid, users::Model> = users::Entity::find()
        .filter(users::Column::Id.is_in(ids))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|u| (u.id, u))
        .collect();

    let mut out = Vec::with_capacity(memberships.len());
    for membership in memberships {
        if let Some(user) = by_id.get(&membership.user_id) {
            out.push(MemberDto {
                user_id: user.id,
                display_name: user.display_name.clone(),
                title: user.title.clone(),
                role: membership.role,
                is_bot: user.is_bot,
                avatar_url: user
                    .avatar_key
                    .as_deref()
                    .map(|key| crate::files::avatar_url(user.id, key)),
            });
        }
    }
    out.sort_by_key(|m| m.display_name.to_lowercase());
    Ok(Json(out))
}

/// `POST /api/v1/channels/{channel_id}/members`: add other people to a channel.
///
/// Joining is something you do to yourself (`PUT .../membership`); this is the other half, and it
/// did not exist. The dialog offering it showed every member of the space with a checkbox, added
/// nobody, and reported success, which also made it look as though unchecking someone would remove
/// them. Removing is a third thing, with its own authorization, and is not this endpoint either.
///
/// Anyone who is in the channel may bring someone else in, as in every tool people arrive here
/// from; a moderator of the space may do it without being in the channel themselves. Targets must
/// already belong to the space: a channel is not a way into one.
#[utoipa::path(
    post,
    path = "/api/v1/channels/{channel_id}/members",
    tag = "messaging",
    params(("channel_id" = Uuid, Path, description = "Channel id")),
    request_body = AddChannelMembersRequest,
    responses(
        (status = 200, description = "Who was added, skipping those already in", body = AddedMembersDto),
        (status = 400, description = "The channel is archived, or a target is not in the space"),
        (status = 403, description = "Not allowed to add people to this channel")
    )
)]
pub async fn add_channel_members(
    State(state): State<AppState>,
    session: AuthSession,
    Path(channel_id): Path<Uuid>,
    Json(body): Json<AddChannelMembersRequest>,
) -> Result<Json<AddedMembersDto>, ApiError> {
    let channel = channels::Entity::find_by_id(channel_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::Forbidden)?;
    ensure_space_member(&state.db, channel.space_id, session.user_id).await?;
    if channel.channel_type == "archived" {
        return Err(ApiError::BadRequest("this channel is archived"));
    }

    let caller_is_member = channel_members::Entity::find_by_id((channel_id, session.user_id))
        .one(&state.db)
        .await?
        .is_some();
    if !caller_is_member
        && !is_channel_moderator(&state.db, channel_id, channel.space_id, session.user_id).await?
    {
        return Err(ApiError::Forbidden);
    }

    // Everyone in the space, so a target outside it is refused without a query per person, and
    // without confirming to the caller whether an id belongs to an account elsewhere.
    let in_space: std::collections::HashSet<Uuid> =
        space_member_ids(&state.db, channel.space_id, session.user_id)
            .await?
            .into_iter()
            .collect();
    let already: std::collections::HashSet<Uuid> = channel_members::Entity::find()
        .filter(channel_members::Column::ChannelId.eq(channel_id))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|m| m.user_id)
        .collect();

    let now = OffsetDateTime::now_utc();
    let mut added = Vec::new();
    for user_id in body.user_ids.iter().copied() {
        if !in_space.contains(&user_id) {
            return Err(ApiError::BadRequest(
                "someone in this list does not belong to the space",
            ));
        }
        // Already in is not an error: the dialog may be working from a list a moment out of date,
        // and the outcome the caller asked for is already true.
        if already.contains(&user_id) {
            continue;
        }
        join_row(&state.db, channel_id, user_id, "member", now).await?;
        added.push(user_id);
    }
    // One notice per arrival, after the writes: the channel's history is how the people already in
    // it learn who turned up, and a member list that silently grows is the same defect as one that
    // silently shrinks.
    for user_id in &added {
        write_channel_notice(&state, channel_id, Some(*user_id), JOINED_EVENT).await;
    }

    // A private channel is invisible until you are in it, so the people just added have to be told
    // it exists; for a public one they could already see it, and the sidebar only gains the
    // membership mark on their next load.
    if !added.is_empty() && channel.channel_type == "private" {
        let summary = ChannelSummaryDto {
            id: channel_id,
            space_id: channel.space_id,
            name: channel.name.clone(),
            channel_type: channel.channel_type.clone(),
            topic: channel.topic.clone(),
        };
        state
            .hub
            .publish(
                added.clone(),
                RealtimeEnvelope::channel_created(channel_id, &summary),
            )
            .await;
    }

    Ok(Json(AddedMembersDto { added }))
}

/// `PUT /api/v1/channels/{channel_id}/favorite`: pin a channel to the caller's favourites, or unpin.
///
/// Per caller, not per channel: a favourite is one person's shortcut and says nothing to anyone
/// else. The column has been read and reported since the channel list existed, and nothing could
/// ever write it, so the sidebar kept a "Canaux favoris" section that could not fill.
#[utoipa::path(
    put,
    path = "/api/v1/channels/{channel_id}/favorite",
    tag = "messaging",
    params(("channel_id" = Uuid, Path, description = "Channel id")),
    request_body = FavoriteRequest,
    responses(
        (status = 204, description = "Favourite set"),
        (status = 403, description = "Not a member of the channel")
    )
)]
pub async fn set_favorite(
    State(state): State<AppState>,
    session: AuthSession,
    Path(channel_id): Path<Uuid>,
    Json(body): Json<FavoriteRequest>,
) -> Result<StatusCode, ApiError> {
    // Only a member can favourite a channel: the row that carries the flag is the membership.
    let membership = channel_members::Entity::find_by_id((channel_id, session.user_id))
        .one(&state.db)
        .await?
        .ok_or(ApiError::Forbidden)?;

    let mut active = membership.into_active_model();
    active.favorite = Set(body.favorite);
    active.update(&state.db).await?;
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

    let membership = channel_members::Entity::find_by_id((channel_id, session.user_id))
        .one(&state.db)
        .await?;
    channel_members::Entity::delete_by_id((channel_id, session.user_id))
        .exec(&state.db)
        .await?;
    // Written after the row is gone, so the audience is the people who stayed. Only if there was
    // something to leave: this endpoint is idempotent, and a second press says nothing.
    if membership.is_some() {
        write_channel_notice(&state, channel_id, Some(session.user_id), LEFT_EVENT).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Who should learn that a channel exists: every member of the space for a public (or archived)
/// channel, since they all see it listed, and only its own members for a private one, whose very
/// existence is not public.
async fn channel_audience(
    db: &DatabaseConnection,
    space_id: Uuid,
    channel_id: Uuid,
    channel_type: &str,
    user_id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    if channel_type == "private" {
        return Ok(channel_members::Entity::find()
            .filter(channel_members::Column::ChannelId.eq(channel_id))
            .all(db)
            .await?
            .into_iter()
            .map(|m| m.user_id)
            .collect());
    }
    space_member_ids(db, space_id, user_id).await
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
