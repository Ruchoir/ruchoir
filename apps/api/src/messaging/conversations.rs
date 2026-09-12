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
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, DatabaseConnection, DbBackend,
    EntityTrait, PaginatorTrait, QueryFilter, Statement, TransactionTrait,
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

    // Both counters come from one grouped statement each, not from the per-conversation helper: the
    // sidebar can afford two queries per conversation for the one space on screen, the rail cannot
    // afford them for every conversation of every space on every boot.
    let unread_by_space = unread_messages_by_space(&state.db, session.user_id).await?;
    let mentions_by_space = unread_notifications_by_space(&state.db, session.user_id).await?;

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
            unread: unread_by_space.get(&space.id).copied().unwrap_or(0),
            mentions: mentions_by_space.get(&space.id).copied().unwrap_or(0),
            icon_url: space
                .icon_key
                .as_deref()
                .map(|key| crate::files::icon_url(space.id, key)),
        });
    }
    out.sort_by_key(|space| space.name.to_lowercase());
    Ok(Json(out))
}

/// Unread root messages per space, for the conversations the caller has actually joined.
///
/// Mirrors [`unread_count`] exactly (root messages only, tombstones excluded, never the caller's
/// own, everything after the timestamp of the caller's last-read message) but for every space at
/// once. Written as SQL because
/// the whole point is to replace N per-conversation round trips with one grouped scan; the shape is
/// small enough to read, and every value is bound rather than interpolated.
async fn unread_messages_by_space(
    db: &DatabaseConnection,
    user_id: Uuid,
) -> Result<HashMap<Uuid, i64>, ApiError> {
    // A conversation counts only if the caller joined it: a public channel they can read but have
    // not joined is not "theirs", and is not pushed to them either.
    let sql = "SELECT c.space_id AS space_id, COUNT(m.id) AS unread \
                 FROM messages m \
                 JOIN conversations c ON c.id = m.conversation_id \
                 LEFT JOIN read_cursors rc \
                   ON rc.conversation_id = m.conversation_id AND rc.user_id = $1 \
                 LEFT JOIN messages lm ON lm.id = rc.last_read_message_id \
                WHERE m.parent_message_id IS NULL \
                  AND m.deleted_at IS NULL \
                  AND m.kind <> 'system' \
                  AND (m.author_id IS NULL OR m.author_id <> $1) \
                  AND (lm.created_at IS NULL OR m.created_at > lm.created_at) \
                  AND ( \
                    m.conversation_id IN (SELECT channel_id FROM channel_members WHERE user_id = $1) \
                    OR m.conversation_id IN (SELECT dm_id FROM dm_participants WHERE user_id = $1) \
                  ) \
                GROUP BY c.space_id";
    count_by_space(db, sql, user_id, "unread").await
}

/// Unread notifications per space: the caller's inbox (mention, thread reply, direct message),
/// grouped through the conversation each one points at.
///
/// Deliberately the same rows the notification centre shows, so the rail's number can never drift
/// from what opening the inbox will reveal.
async fn unread_notifications_by_space(
    db: &DatabaseConnection,
    user_id: Uuid,
) -> Result<HashMap<Uuid, i64>, ApiError> {
    let sql = "SELECT c.space_id AS space_id, COUNT(n.id) AS unread \
                 FROM notifications n \
                 JOIN conversations c ON c.id = n.conversation_id \
                WHERE n.user_id = $1 AND n.read_at IS NULL \
                GROUP BY c.space_id";
    count_by_space(db, sql, user_id, "unread").await
}

/// Run a `space_id`/count statement bound to one user and collect it into a map.
async fn count_by_space(
    db: &DatabaseConnection,
    sql: &str,
    user_id: Uuid,
    column: &str,
) -> Result<HashMap<Uuid, i64>, ApiError> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            [user_id.into()],
        ))
        .await?;
    rows.iter()
        .map(|row| {
            Ok((
                row.try_get::<Uuid>("", "space_id")?,
                row.try_get::<i64>("", column)?,
            ))
        })
        .collect()
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
    // A guest is offered nothing they were not added to, so for them every channel is listed the
    // way a private one is. Same test as the one that would refuse them the conversation itself.
    let explicit_only = super::authz::is_guest(&state.db, space_id, session.user_id).await?;

    let mut out = Vec::new();
    for channel in all {
        // Private channels are visible only to their members; public/archived to any space member.
        let membership = channel_members::Entity::find_by_id((channel.id, session.user_id))
            .one(&state.db)
            .await?;
        if (channel.channel_type == "private" || explicit_only) && membership.is_none() {
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

    // Everyone, or for a guest only the people they share a conversation with: restricting what
    // someone reads while handing them the directory would defeat the point of the role.
    let visible = super::authz::visible_member_ids(&state.db, space_id, session.user_id).await?;
    let memberships = space_members::Entity::find()
        .filter(space_members::Column::SpaceId.eq(space_id))
        .filter(space_members::Column::UserId.is_in(visible))
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
    // Every participant must belong to the space, and must be someone the caller may address: a
    // guest writes to the people they already share a conversation with, not to anyone whose id they
    // can guess.
    let addressable: BTreeSet<Uuid> =
        super::authz::visible_member_ids(&state.db, space_id, session.user_id)
            .await?
            .into_iter()
            .collect();
    for user_id in &participants {
        if !is_space_member(&state.db, space_id, *user_id).await? {
            return Err(ApiError::BadRequest("a participant is not in this space"));
        }
        if !addressable.contains(user_id) {
            return Err(ApiError::Forbidden);
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

/// Where a set of conversations live, in words: the channel's name (absent for a direct message)
/// and the space's.
///
/// Shared by the notification feed and the saved list, which both hand a client rows pointing at
/// conversations it may never have loaded. A client cannot name those, so anything that travels
/// outside the space on screen carries its labels with it, and the two lists derive them the same
/// way rather than each growing its own.
pub(super) struct ConversationLabel {
    pub space_id: Uuid,
    pub space_name: String,
    /// The channel's name; `None` for a direct message, which is how the two are told apart.
    pub channel_name: Option<String>,
}

pub(super) async fn label_conversations<C: ConnectionTrait>(
    db: &C,
    ids: Vec<Uuid>,
) -> Result<HashMap<Uuid, ConversationLabel>, ApiError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }

    let spaces_by_conversation: HashMap<Uuid, Uuid> = conversations::Entity::find()
        .filter(conversations::Column::Id.is_in(ids.clone()))
        .all(db)
        .await?
        .into_iter()
        .map(|c| (c.id, c.space_id))
        .collect();

    // A channel and its conversation share an id, so this is a lookup by the same key.
    let channel_names: HashMap<Uuid, String> = channels::Entity::find()
        .filter(channels::Column::Id.is_in(ids))
        .all(db)
        .await?
        .into_iter()
        .map(|c| (c.id, c.name))
        .collect();

    let space_names: HashMap<Uuid, String> = spaces::Entity::find()
        .filter(
            spaces::Column::Id.is_in(spaces_by_conversation.values().copied().collect::<Vec<_>>()),
        )
        .all(db)
        .await?
        .into_iter()
        .map(|s| (s.id, s.name))
        .collect();

    Ok(spaces_by_conversation
        .into_iter()
        .map(|(conversation_id, space_id)| {
            (
                conversation_id,
                ConversationLabel {
                    space_id,
                    space_name: space_names.get(&space_id).cloned().unwrap_or_default(),
                    channel_name: channel_names.get(&conversation_id).cloned(),
                },
            )
        })
        .collect())
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
        .filter(messages::Column::DeletedAt.is_null())
        // System notices are not something anyone is behind on. It matters now that they are written
        // at runtime: without this, every arrival in a space would bump the unread badge of every
        // member of the channel it was announced in.
        .filter(messages::Column::Kind.ne("system"))
        // Nobody is behind on what they wrote themselves. Without this, sending a message lit the
        // badge of the space it was sent from until the sender's own read cursor caught up, which
        // is a space telling someone they have not read themselves.
        .filter(
            Condition::any()
                .add(messages::Column::AuthorId.is_null())
                .add(messages::Column::AuthorId.ne(user_id)),
        );
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
