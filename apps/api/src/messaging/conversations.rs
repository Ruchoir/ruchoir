//! Conversation listing and direct-message creation for a space's sidebar.
//!
//! These endpoints back the channel and DM lists: the channels a caller can see (public/archived
//! channels of the space, plus private channels they have joined), their DMs, and a get-or-create
//! for opening a direct message. Each row carries an unread count derived from the caller's read
//! cursor, so the sidebar badges come straight from the API.

use std::collections::{BTreeSet, HashMap};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter,
    TransactionTrait,
};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{
    channel_members, channels, conversations, dm_conversations, dm_participants, messages,
    read_cursors, space_members, spaces, users,
};
use crate::state::AppState;

use super::authz::{ensure_space_member, is_space_member};
use super::dto::{
    ChannelDto, ConversationRef, CreateDmRequest, DirectMessageDto, MemberDto, SpaceDto,
};
use super::error::ApiError;

/// `GET /api/v1/me/spaces`: the spaces the caller belongs to, with their role in each.
///
/// This is the SPA bootstrap: channels and DMs are queried per space, so the client first needs
/// the set of spaces it can enter. Ordered by name for a stable workspace switcher.
#[utoipa::path(
    get,
    path = "/api/v1/me/spaces",
    tag = "messaging",
    responses((status = 200, description = "Spaces the caller belongs to", body = [SpaceDto]))
)]
pub async fn list_my_spaces(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<Json<Vec<SpaceDto>>, ApiError> {
    let memberships = space_members::Entity::find()
        .filter(space_members::Column::UserId.eq(session.user_id))
        .all(&state.db)
        .await?;

    let mut out = Vec::with_capacity(memberships.len());
    for membership in memberships {
        // A membership row can outlive its space only through a bug; skip rather than fail the list.
        let Some(space) = spaces::Entity::find_by_id(membership.space_id)
            .one(&state.db)
            .await?
        else {
            continue;
        };
        let members = space_members::Entity::find()
            .filter(space_members::Column::SpaceId.eq(space.id))
            .count(&state.db)
            .await? as i64;
        out.push(SpaceDto {
            id: space.id,
            name: space.name,
            slug: space.slug,
            role: membership.role,
            members,
        });
    }
    out.sort_by_key(|space| space.name.to_lowercase());
    Ok(Json(out))
}

/// `GET /api/v1/spaces/{space_id}/channels`: channels the caller can see, with unread counts.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/channels",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "Visible channels", body = [ChannelDto]),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn list_channels(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Json<Vec<ChannelDto>>, ApiError> {
    ensure_space_member(&state.db, space_id, session.user_id).await?;

    let all = channels::Entity::find()
        .filter(channels::Column::SpaceId.eq(space_id))
        .all(&state.db)
        .await?;

    let mut out = Vec::new();
    for channel in all {
        // Private channels are visible only to their members; public/archived to any space member.
        let membership = channel_members::Entity::find_by_id((channel.id, session.user_id))
            .one(&state.db)
            .await?;
        if channel.channel_type == "private" && membership.is_none() {
            continue;
        }
        let favorite = membership.as_ref().map(|m| m.favorite).unwrap_or(false);
        let unread = unread_count(&state.db, channel.id, session.user_id).await?;
        out.push(ChannelDto {
            id: channel.id,
            name: channel.name,
            channel_type: channel.channel_type,
            topic: channel.topic,
            imported: channel.imported_source,
            favorite,
            member: membership.is_some(),
            unread,
        });
    }
    Ok(Json(out))
}

/// `GET /api/v1/spaces/{space_id}/members`: the members of a space, for the member list, the
/// `@`-mention directory and the people section of search. Presence is overlaid client-side.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/members",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "The space's members", body = [MemberDto]),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn list_members(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Json<Vec<MemberDto>>, ApiError> {
    ensure_space_member(&state.db, space_id, session.user_id).await?;

    let memberships = space_members::Entity::find()
        .filter(space_members::Column::SpaceId.eq(space_id))
        .all(&state.db)
        .await?;
    let ids: Vec<Uuid> = memberships.iter().map(|m| m.user_id).collect();
    let by_id: HashMap<Uuid, users::Model> = users::Entity::find()
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
            });
        }
    }
    out.sort_by_key(|m| m.display_name.to_lowercase());
    Ok(Json(out))
}

/// `GET /api/v1/spaces/{space_id}/dms`: the caller's direct-message conversations in a space.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/dms",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 200, description = "Direct-message conversations", body = [DirectMessageDto]),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn list_dms(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<Json<Vec<DirectMessageDto>>, ApiError> {
    ensure_space_member(&state.db, space_id, session.user_id).await?;

    // The caller's own participant rows, skipping conversations they have hidden.
    let mine = dm_participants::Entity::find()
        .filter(dm_participants::Column::UserId.eq(session.user_id))
        .all(&state.db)
        .await?;

    let mut out = Vec::new();
    for participation in mine {
        if participation.hidden {
            continue;
        }
        let Some(dm) = dm_conversations::Entity::find_by_id(participation.dm_id)
            .one(&state.db)
            .await?
        else {
            continue;
        };
        if dm.space_id != space_id {
            continue;
        }

        let counterparts = other_participants(&state.db, dm.id, session.user_id).await?;
        let name = counterparts
            .iter()
            .map(|u| u.display_name.clone())
            .collect::<Vec<_>>()
            .join(", ");
        let bot = counterparts.len() == 1 && counterparts[0].is_bot;
        let user_id = (counterparts.len() == 1).then(|| counterparts[0].id);
        let unread = unread_count(&state.db, dm.id, session.user_id).await?;
        out.push(DirectMessageDto {
            id: dm.id,
            name,
            is_group: dm.is_group,
            user_id,
            bot,
            unread,
        });
    }
    Ok(Json(out))
}

/// `POST /api/v1/spaces/{space_id}/dm`: open (or fetch) a direct message with a set of users.
#[utoipa::path(
    post,
    path = "/api/v1/spaces/{space_id}/dm",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    request_body = CreateDmRequest,
    responses(
        (status = 200, description = "Existing conversation returned", body = ConversationRef),
        (status = 201, description = "New conversation created", body = ConversationRef),
        (status = 400, description = "No counterpart, or a user is not in the space"),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn create_dm(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Json(body): Json<CreateDmRequest>,
) -> Result<(StatusCode, Json<ConversationRef>), ApiError> {
    ensure_space_member(&state.db, space_id, session.user_id).await?;

    // The full participant set: the caller plus the requested users, de-duplicated.
    let mut participants: BTreeSet<Uuid> = body.user_ids.into_iter().collect();
    participants.insert(session.user_id);
    if participants.len() < 2 {
        return Err(ApiError::BadRequest(
            "a direct message needs another participant",
        ));
    }
    // Every participant must belong to the space.
    for user_id in &participants {
        if !is_space_member(&state.db, space_id, *user_id).await? {
            return Err(ApiError::BadRequest("a participant is not in this space"));
        }
    }

    // Reuse an existing conversation with exactly this participant set, if any.
    if let Some(existing) = find_existing_dm(&state.db, space_id, &participants).await? {
        return Ok((StatusCode::OK, Json(ConversationRef { id: existing })));
    }

    let dm_id = Uuid::new_v4();
    let now = OffsetDateTime::now_utc();
    let is_group = participants.len() > 2;

    let txn = state.db.begin().await?;
    conversations::ActiveModel {
        id: Set(dm_id),
        space_id: Set(space_id),
        kind: Set("direct".to_owned()),
        created_at: Set(now),
    }
    .insert(&txn)
    .await?;
    dm_conversations::ActiveModel {
        id: Set(dm_id),
        space_id: Set(space_id),
        is_group: Set(is_group),
        created_by: Set(Some(session.user_id)),
        created_at: Set(now),
    }
    .insert(&txn)
    .await?;
    for user_id in &participants {
        dm_participants::ActiveModel {
            dm_id: Set(dm_id),
            user_id: Set(*user_id),
            added_at: Set(now),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
    }
    txn.commit().await?;

    Ok((StatusCode::CREATED, Json(ConversationRef { id: dm_id })))
}

/// Count of unread, non-deleted root messages for a caller in a conversation.
pub(super) async fn unread_count(
    db: &DatabaseConnection,
    conversation_id: Uuid,
    user_id: Uuid,
) -> Result<i64, ApiError> {
    // The timestamp of the caller's last-read message, if any.
    let last_ts = match read_cursors::Entity::find_by_id((conversation_id, user_id))
        .one(db)
        .await?
        .and_then(|c| c.last_read_message_id)
    {
        Some(message_id) => messages::Entity::find_by_id(message_id)
            .one(db)
            .await?
            .map(|m| m.created_at),
        None => None,
    };

    let mut query = messages::Entity::find()
        .filter(messages::Column::ConversationId.eq(conversation_id))
        .filter(messages::Column::ParentMessageId.is_null())
        .filter(messages::Column::DeletedAt.is_null());
    if let Some(ts) = last_ts {
        query = query.filter(messages::Column::CreatedAt.gt(ts));
    }
    Ok(query.count(db).await? as i64)
}

/// The other participants of a DM (everyone but the caller).
async fn other_participants(
    db: &DatabaseConnection,
    dm_id: Uuid,
    caller: Uuid,
) -> Result<Vec<users::Model>, ApiError> {
    let ids: Vec<Uuid> = dm_participants::Entity::find()
        .filter(dm_participants::Column::DmId.eq(dm_id))
        .all(db)
        .await?
        .into_iter()
        .map(|p| p.user_id)
        .filter(|id| *id != caller)
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(users::Entity::find()
        .filter(users::Column::Id.is_in(ids))
        .all(db)
        .await?)
}

/// Find a DM in a space whose participant set is exactly `participants`.
async fn find_existing_dm(
    db: &DatabaseConnection,
    space_id: Uuid,
    participants: &BTreeSet<Uuid>,
) -> Result<Option<Uuid>, ApiError> {
    // Candidate DMs are those the caller (any member of the set) already participates in.
    let any_member = *participants.iter().next().expect("non-empty set");
    let candidate_ids: Vec<Uuid> = dm_participants::Entity::find()
        .filter(dm_participants::Column::UserId.eq(any_member))
        .all(db)
        .await?
        .into_iter()
        .map(|p| p.dm_id)
        .collect();

    for dm_id in candidate_ids {
        let Some(dm) = dm_conversations::Entity::find_by_id(dm_id).one(db).await? else {
            continue;
        };
        if dm.space_id != space_id {
            continue;
        }
        let members: BTreeSet<Uuid> = dm_participants::Entity::find()
            .filter(dm_participants::Column::DmId.eq(dm_id))
            .all(db)
            .await?
            .into_iter()
            .map(|p| p.user_id)
            .collect();
        if &members == participants {
            return Ok(Some(dm_id));
        }
    }
    Ok(None)
}
