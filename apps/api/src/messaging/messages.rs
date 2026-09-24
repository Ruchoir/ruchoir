//! Message endpoints: history, send, thread replies, edit and delete.
//!
//! Reads and writes both funnel through [`authz::ensure_conversation_access`], so a handler that
//! reaches its body is authorized. After a successful write the handler fans the resulting event
//! out through the hub; the write itself is a normal REST call, never a socket command.
//!
//! [`hydrate_messages`] is the shared builder that turns raw `messages` rows into [`MessageDto`]s,
//! batch-loading reactions, mentions, pins, saved flags and author names so a page costs a fixed
//! handful of queries rather than one per message.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DatabaseTransaction, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, TransactionTrait,
};
use serde::Deserialize;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{
    channel_pins, files, message_attachments, message_link_previews, message_mentions,
    message_reactions, messages, user_saved_messages, users,
};
use crate::realtime::event::RealtimeEnvelope;
use crate::realtime::presence;
use crate::state::AppState;

use super::authz::{self, ConversationKind};
use super::dto::{rfc3339, MessageDto, MessagePage, ReactionDto, SendMessageRequest};
use super::error::ApiError;
use super::mentions;
use super::notifications;

/// How many faces a thread shows next to its reply count. Slack-sized: enough to recognize who is
/// in a conversation, few enough to stay one line at any panel width.
const MAX_REPLY_FACES: usize = 3;

/// Default and maximum page sizes for message history.
const DEFAULT_LIMIT: u64 = 50;
const MAX_LIMIT: u64 = 100;
/// Upper bound on a message body, in characters. A generous cap that still rejects abuse.
const MAX_BODY_CHARS: usize = 8_000;

/// Query string for message history pagination.
#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    /// Fetch messages strictly older than this message id (the previous page's `next_before`).
    #[serde(default)]
    pub before: Option<Uuid>,
    /// Page size (clamped to [`MAX_LIMIT`]).
    #[serde(default)]
    pub limit: Option<u64>,
}

/// `GET /api/v1/conversations/{conversation_id}/messages`: a page of history, oldest-last.
#[utoipa::path(
    get,
    path = "/api/v1/conversations/{conversation_id}/messages",
    tag = "messaging",
    params(
        ("conversation_id" = Uuid, Path, description = "Conversation id"),
        ("before" = Option<Uuid>, Query, description = "Fetch messages older than this id"),
        ("limit" = Option<u64>, Query, description = "Page size (max 100)")
    ),
    responses(
        (status = 200, description = "A page of messages", body = MessagePage),
        (status = 403, description = "No access to the conversation")
    )
)]
pub async fn list_messages(
    State(state): State<AppState>,
    session: AuthSession,
    Path(conversation_id): Path<Uuid>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<MessagePage>, ApiError> {
    authz::ensure_conversation_access(&state.db, conversation_id, session.user_id).await?;

    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let mut select = messages::Entity::find()
        .filter(messages::Column::ConversationId.eq(conversation_id))
        .filter(messages::Column::ParentMessageId.is_null());

    // Cursor: everything strictly older than the `before` message's timestamp.
    if let Some(before) = query.before {
        if let Some(anchor) = messages::Entity::find_by_id(before).one(&state.db).await? {
            select = select.filter(messages::Column::CreatedAt.lt(anchor.created_at));
        }
    }

    // Fetch newest-first with one extra row to detect whether an older page exists, then flip to
    // chronological order for display.
    let mut rows = select
        .order_by_desc(messages::Column::CreatedAt)
        .order_by_desc(messages::Column::Id)
        .limit(limit + 1)
        .all(&state.db)
        .await?;

    let has_more = rows.len() as u64 > limit;
    rows.truncate(limit as usize);
    rows.reverse();

    let next_before = if has_more {
        rows.first().map(|m| m.id)
    } else {
        None
    };

    let messages = hydrate_messages(&state.db, session.user_id, rows).await?;
    Ok(Json(MessagePage {
        messages,
        next_before,
    }))
}

/// `GET /api/v1/messages/{message_id}/replies`: the thread under a message, chronological.
#[utoipa::path(
    get,
    path = "/api/v1/messages/{message_id}/replies",
    tag = "messaging",
    params(("message_id" = Uuid, Path, description = "Root message id")),
    responses(
        (status = 200, description = "Thread replies", body = [MessageDto]),
        (status = 403, description = "No access to the conversation"),
        (status = 404, description = "Message not found")
    )
)]
pub async fn list_replies(
    State(state): State<AppState>,
    session: AuthSession,
    Path(message_id): Path<Uuid>,
) -> Result<Json<Vec<MessageDto>>, ApiError> {
    let parent = load_message(&state.db, message_id).await?;
    authz::ensure_conversation_access(&state.db, parent.conversation_id, session.user_id).await?;

    let rows = messages::Entity::find()
        .filter(messages::Column::ParentMessageId.eq(message_id))
        .order_by_asc(messages::Column::CreatedAt)
        .order_by_asc(messages::Column::Id)
        .all(&state.db)
        .await?;

    Ok(Json(
        hydrate_messages(&state.db, session.user_id, rows).await?,
    ))
}

/// `POST /api/v1/conversations/{conversation_id}/messages`: post a message or a threaded reply.
#[utoipa::path(
    post,
    path = "/api/v1/conversations/{conversation_id}/messages",
    tag = "messaging",
    params(("conversation_id" = Uuid, Path, description = "Conversation id")),
    request_body = SendMessageRequest,
    responses(
        (status = 201, description = "Message created", body = MessageDto),
        (status = 400, description = "Empty or oversized body, or invalid parent"),
        (status = 403, description = "No access, or the channel is archived")
    )
)]
pub async fn send_message(
    State(state): State<AppState>,
    session: AuthSession,
    Path(conversation_id): Path<Uuid>,
    Json(body): Json<SendMessageRequest>,
) -> Result<(StatusCode, Json<MessageDto>), ApiError> {
    let access =
        authz::ensure_conversation_access(&state.db, conversation_id, session.user_id).await?;
    if !access.is_postable() {
        return Err(ApiError::Forbidden);
    }

    let text = body.body.trim();
    // A message needs *something*: text, or a file. Sending a document with no caption is an ordinary
    // thing to do, and refusing it made the attachment feature unusable on its own.
    if text.is_empty() && body.attachments.is_empty() {
        return Err(ApiError::BadRequest("a message needs text or a file"));
    }
    if text.chars().count() > MAX_BODY_CHARS {
        return Err(ApiError::BadRequest("message body is too long"));
    }

    // A reply must target a message in the same conversation; remember its author to notify them.
    let mut reply_target: Option<Uuid> = None;
    if let Some(parent_id) = body.parent_message_id {
        let parent = load_message(&state.db, parent_id).await?;
        if parent.conversation_id != conversation_id {
            return Err(ApiError::BadRequest(
                "parent message is in another conversation",
            ));
        }
        reply_target = parent.author_id;
    }

    // Writing in a channel, a thread reply included, is for its members. Reading it is not.
    if access.kind == authz::ConversationKind::Channel {
        super::channels::ensure_taking_part(&state, conversation_id, session.user_id).await?;
    }

    let audience = authz::conversation_audience(&state.db, &access).await?;
    let tokens = mentions::extract_mention_tokens(text);
    let mut resolved =
        mentions::resolve_mentions(&state.db, session.user_id, &audience, text, &tokens).await?;

    // `@ici` means the people who are here. The resolver expands it to every member, because it
    // knows the conversation and not who is connected, so the narrowing happens here, where the
    // presence heartbeat is reachable. Without it `@ici` and `@canal` did the same thing under two
    // names, which leaves the reader to guess which one is the loud one.
    if tokens.here && !tokens.channel {
        let mut present = Vec::with_capacity(resolved.len());
        for mention in resolved {
            let keep = mention.mention_type != "here"
                || presence::is_online(state.hub.valkey(), mention.user_id).await;
            if keep {
                present.push(mention);
            }
        }
        resolved = present;
    }

    // Who to notify: mentions, the other DM participants, and the replied-to author (deduped by
    // priority, never the sender).
    //
    // Being named and being one of the room are kept apart. `@here` and `@channel` expand to one
    // row per member, so they arrive here looking exactly like a mention by name, and a reader who
    // has asked not to be pulled out of their afternoon by `@channel` has no way to be obeyed
    // unless the two are distinguishable downstream.
    let mention_ids: Vec<Uuid> = resolved
        .iter()
        .filter(|m| m.mention_type == "user")
        .map(|m| m.user_id)
        .collect();
    let broadcast_ids: Vec<Uuid> = resolved
        .iter()
        .filter(|m| m.mention_type != "user")
        .map(|m| m.user_id)
        .collect();
    let dm_recipients: Vec<Uuid> = if access.kind == ConversationKind::Direct {
        audience
            .iter()
            .copied()
            .filter(|user_id| *user_id != session.user_id)
            .collect()
    } else {
        Vec::new()
    };
    let recipients = notifications::compute_recipients(
        session.user_id,
        &mention_ids,
        &broadcast_ids,
        &dm_recipients,
        reply_target,
    );

    let message_id = Uuid::new_v4();
    let now = OffsetDateTime::now_utc();

    let txn = state.db.begin().await?;
    messages::ActiveModel {
        id: Set(message_id),
        conversation_id: Set(conversation_id),
        author_id: Set(Some(session.user_id)),
        kind: Set("message".to_owned()),
        body: Set(text.to_owned()),
        parent_message_id: Set(body.parent_message_id),
        created_at: Set(now),
        ..Default::default()
    }
    .insert(&txn)
    .await?;

    for mention in &resolved {
        message_mentions::ActiveModel {
            message_id: Set(message_id),
            mentioned_user_id: Set(mention.user_id),
            mention_type: Set(mention.mention_type.to_owned()),
        }
        .insert(&txn)
        .await?;
    }

    // Persist the notifications alongside the message so they commit atomically.
    let notif_rows = notifications::create_for_message(
        &txn,
        session.user_id,
        conversation_id,
        message_id,
        &recipients,
    )
    .await?;

    // Link any attachments. Each must be a live file in the conversation's space; a space member
    // (which conversation access implies) may read any file in that space, so no further ACL check
    // is needed here. Duplicates are dropped, order preserved.
    if !body.attachments.is_empty() {
        let mut seen: HashSet<Uuid> = HashSet::new();
        let mut position = 0;
        for file_id in &body.attachments {
            if !seen.insert(*file_id) {
                continue;
            }
            let file = files::Entity::find_by_id(*file_id)
                .one(&txn)
                .await?
                .ok_or(ApiError::BadRequest("attachment not found"))?;
            if file.space_id != access.space_id
                || file.deleted_at.is_some()
                || file.kind == "folder"
            {
                return Err(ApiError::BadRequest("invalid attachment"));
            }
            message_attachments::ActiveModel {
                message_id: Set(message_id),
                file_id: Set(*file_id),
                file_version_id: Set(file.current_version_id),
                position: Set(position),
                ..Default::default()
            }
            .insert(&txn)
            .await?;
            position += 1;
        }
    }

    // Bump the denormalized reply counter on the parent.
    if let Some(parent_id) = body.parent_message_id {
        adjust_reply_count(&txn, parent_id, 1).await?;
    }
    txn.commit().await?;

    let dto = hydrate_messages(
        &state.db,
        session.user_id,
        vec![load_message(&state.db, message_id).await?],
    )
    .await?
    .pop()
    .ok_or(ApiError::Internal)?;

    state
        .hub
        .publish(
            audience,
            RealtimeEnvelope::message_created(conversation_id, dto.clone()),
        )
        .await;

    // Its first link is read in the background and the message pushed again with the preview.
    super::unfurl::refresh(&state, message_id);

    // Push each notification to its recipient (user-scoped, one audience per row), and announce it
    // to the browsers that asked for Web Push, in the background.
    crate::notify::push::dispatch(&state, &notif_rows);
    if !notif_rows.is_empty() {
        let targets: Vec<Uuid> = notif_rows.iter().map(|row| row.user_id).collect();
        let notif_dtos = notifications::hydrate(&state.db, notif_rows).await?;
        for (user_id, notif) in targets.into_iter().zip(notif_dtos) {
            state
                .hub
                .publish(vec![user_id], RealtimeEnvelope::notification_created(notif))
                .await;
        }
    }

    Ok((StatusCode::CREATED, Json(dto)))
}

/// `PATCH /api/v1/messages/{message_id}`: edit a message (author only).
#[utoipa::path(
    patch,
    path = "/api/v1/messages/{message_id}",
    tag = "messaging",
    params(("message_id" = Uuid, Path, description = "Message id")),
    request_body = super::dto::EditMessageRequest,
    responses(
        (status = 200, description = "Message updated", body = MessageDto),
        (status = 403, description = "Not the author"),
        (status = 404, description = "Message not found")
    )
)]
pub async fn edit_message(
    State(state): State<AppState>,
    session: AuthSession,
    Path(message_id): Path<Uuid>,
    Json(body): Json<super::dto::EditMessageRequest>,
) -> Result<Json<MessageDto>, ApiError> {
    let message = load_message(&state.db, message_id).await?;
    let access =
        authz::ensure_conversation_access(&state.db, message.conversation_id, session.user_id)
            .await?;

    if message.author_id != Some(session.user_id) {
        return Err(ApiError::Forbidden);
    }
    if message.deleted_at.is_some() {
        return Err(ApiError::BadRequest("cannot edit a deleted message"));
    }

    let text = body.body.trim();
    let existing_attachments = message_attachments::Entity::find()
        .filter(message_attachments::Column::MessageId.eq(message_id))
        .order_by_asc(message_attachments::Column::Position)
        .all(&state.db)
        .await?;
    if text.is_empty() && existing_attachments.is_empty() && body.attachments.is_empty() {
        return Err(ApiError::BadRequest("a message needs text or a file"));
    }
    if text.chars().count() > MAX_BODY_CHARS {
        return Err(ApiError::BadRequest("message body is too long"));
    }

    let conversation_id = message.conversation_id;
    let audience = authz::conversation_audience(&state.db, &access).await?;
    let tokens = mentions::extract_mention_tokens(text);
    let resolved =
        mentions::resolve_mentions(&state.db, session.user_id, &audience, text, &tokens).await?;

    let txn = state.db.begin().await?;
    let mut active = message.into_active_model();
    active.body = Set(text.to_owned());
    active.edited_at = Set(Some(OffsetDateTime::now_utc()));
    active.update(&txn).await?;

    // Rebuild the mention set for the new body.
    message_mentions::Entity::delete_many()
        .filter(message_mentions::Column::MessageId.eq(message_id))
        .exec(&txn)
        .await?;
    for mention in &resolved {
        message_mentions::ActiveModel {
            message_id: Set(message_id),
            mentioned_user_id: Set(mention.user_id),
            mention_type: Set(mention.mention_type.to_owned()),
        }
        .insert(&txn)
        .await?;
    }

    // Editing adds newly uploaded files without disturbing the files already shared on the
    // message. Repeated ids are ignored, both within this request and against existing links.
    let mut seen: HashSet<Uuid> = existing_attachments
        .iter()
        .map(|attachment| attachment.file_id)
        .collect();
    let mut position = existing_attachments
        .iter()
        .map(|attachment| attachment.position)
        .max()
        .map_or(0, |last| last + 1);
    for file_id in &body.attachments {
        if !seen.insert(*file_id) {
            continue;
        }
        let file = files::Entity::find_by_id(*file_id)
            .one(&txn)
            .await?
            .ok_or(ApiError::BadRequest("attachment not found"))?;
        if file.space_id != access.space_id || file.deleted_at.is_some() || file.kind == "folder" {
            return Err(ApiError::BadRequest("invalid attachment"));
        }
        message_attachments::ActiveModel {
            message_id: Set(message_id),
            file_id: Set(*file_id),
            file_version_id: Set(file.current_version_id),
            position: Set(position),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
        position += 1;
    }
    txn.commit().await?;

    let dto = hydrate_messages(
        &state.db,
        session.user_id,
        vec![load_message(&state.db, message_id).await?],
    )
    .await?
    .pop()
    .ok_or(ApiError::Internal)?;

    state
        .hub
        .publish(
            audience,
            RealtimeEnvelope::message_updated(conversation_id, dto.clone()),
        )
        .await;
    // An edit may have changed, added or removed the link.
    super::unfurl::refresh(&state, message_id);

    Ok(Json(dto))
}

/// `DELETE /api/v1/messages/{message_id}`: soft-delete a message (author or a channel moderator).
#[utoipa::path(
    delete,
    path = "/api/v1/messages/{message_id}",
    tag = "messaging",
    params(("message_id" = Uuid, Path, description = "Message id")),
    responses(
        (status = 200, description = "Message deleted (tombstone)", body = MessageDto),
        (status = 403, description = "Not allowed to delete this message"),
        (status = 404, description = "Message not found")
    )
)]
pub async fn delete_message(
    State(state): State<AppState>,
    session: AuthSession,
    Path(message_id): Path<Uuid>,
) -> Result<Json<MessageDto>, ApiError> {
    let message = load_message(&state.db, message_id).await?;
    let access =
        authz::ensure_conversation_access(&state.db, message.conversation_id, session.user_id)
            .await?;

    let is_author = message.author_id == Some(session.user_id);
    let is_moderator = access.kind == ConversationKind::Channel
        && authz::is_channel_moderator(
            &state.db,
            access.conversation_id,
            access.space_id,
            session.user_id,
        )
        .await?;
    if !is_author && !is_moderator {
        return Err(ApiError::Forbidden);
    }

    let conversation_id = message.conversation_id;
    let audience = authz::conversation_audience(&state.db, &access).await?;
    // A reply that is taken back stops counting: the root advertises "3 replies" and a reader who
    // opens the thread has to find three of them. Deleting twice must not count twice, hence the
    // check on what the row already was.
    let parent_id = message.parent_message_id;
    let was_deleted = message.deleted_at.is_some();

    let txn = state.db.begin().await?;
    let mut active = message.into_active_model();
    // Tombstone: blank the body so deleted content never lingers, keep the row for thread shape.
    active.body = Set(String::new());
    active.deleted_at = Set(Some(OffsetDateTime::now_utc()));
    active.update(&txn).await?;
    message_mentions::Entity::delete_many()
        .filter(message_mentions::Column::MessageId.eq(message_id))
        .exec(&txn)
        .await?;
    if let Some(parent_id) = parent_id {
        if !was_deleted {
            adjust_reply_count(&txn, parent_id, -1).await?;
        }
    }
    txn.commit().await?;

    let dto = hydrate_messages(
        &state.db,
        session.user_id,
        vec![load_message(&state.db, message_id).await?],
    )
    .await?
    .pop()
    .ok_or(ApiError::Internal)?;

    state
        .hub
        .publish(
            audience,
            RealtimeEnvelope::message_deleted(conversation_id, dto.clone()),
        )
        .await;

    // A deleted message keeps no preview, and its thumbnail goes when nothing else shows it.
    super::unfurl::refresh(&state, message_id);

    Ok(Json(dto))
}

/// Move a thread root's denormalized reply counter by `delta`, never below zero.
///
/// The counter is what the feed draws ("3 replies") without reading the thread, so it is kept in
/// the same transaction as the reply that moved it. A root that vanished under us is not an error:
/// there is simply no counter left to keep.
async fn adjust_reply_count(
    txn: &DatabaseTransaction,
    parent_id: Uuid,
    delta: i32,
) -> Result<(), ApiError> {
    let Some(parent) = messages::Entity::find_by_id(parent_id).one(txn).await? else {
        return Ok(());
    };
    let count = (parent.reply_count + delta).max(0);
    let mut active = parent.into_active_model();
    active.reply_count = Set(count);
    active.update(txn).await?;
    Ok(())
}

/// Load a message by id or fail with `404`.
pub async fn load_message(
    db: &DatabaseConnection,
    message_id: Uuid,
) -> Result<messages::Model, ApiError> {
    messages::Entity::find_by_id(message_id)
        .one(db)
        .await?
        .ok_or(ApiError::NotFound)
}

/// Turn raw message rows into DTOs, batch-loading every satellite in a fixed number of queries.
pub async fn hydrate_messages(
    db: &DatabaseConnection,
    caller: Uuid,
    rows: Vec<messages::Model>,
) -> Result<Vec<MessageDto>, ApiError> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<Uuid> = rows.iter().map(|m| m.id).collect();

    // Reactions, kept in first-seen order per message.
    let reaction_rows = message_reactions::Entity::find()
        .filter(message_reactions::Column::MessageId.is_in(ids.clone()))
        .order_by_asc(message_reactions::Column::CreatedAt)
        .all(db)
        .await?;
    // Resolve reactor display names so each bucket can name who reacted.
    let reactor_ids: Vec<Uuid> = reaction_rows.iter().map(|r| r.user_id).collect();
    let mut reactor_names: HashMap<Uuid, String> = HashMap::new();
    if !reactor_ids.is_empty() {
        for user in users::Entity::find()
            .filter(users::Column::Id.is_in(reactor_ids))
            .all(db)
            .await?
        {
            reactor_names.insert(user.id, user.display_name);
        }
    }
    let mut reactions: HashMap<Uuid, Vec<ReactionDto>> = HashMap::new();
    for row in reaction_rows {
        let reactor = reactor_names.get(&row.user_id).cloned().unwrap_or_default();
        let bucket = reactions.entry(row.message_id).or_default();
        if let Some(existing) = bucket.iter_mut().find(|r| r.emoji == row.emoji) {
            existing.count += 1;
            existing.mine = existing.mine || row.user_id == caller;
            existing.users.push(reactor);
        } else {
            bucket.push(ReactionDto {
                emoji: row.emoji,
                count: 1,
                mine: row.user_id == caller,
                users: vec![reactor],
            });
        }
    }

    // Mentions, grouped by message.
    let mention_rows = message_mentions::Entity::find()
        .filter(message_mentions::Column::MessageId.is_in(ids.clone()))
        .all(db)
        .await?;
    let mut mentions_by_msg: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for row in mention_rows {
        mentions_by_msg
            .entry(row.message_id)
            .or_default()
            .push(row.mentioned_user_id);
    }

    // Pinned message ids, and who put each pin there: taking down somebody else's landmark is
    // moderation, so the client needs to know whose it is to stop offering what would be refused.
    let pins: Vec<channel_pins::Model> = channel_pins::Entity::find()
        .filter(channel_pins::Column::MessageId.is_in(ids.clone()))
        .all(db)
        .await?;
    let pinned_by: HashMap<Uuid, Option<Uuid>> =
        pins.iter().map(|p| (p.message_id, p.pinned_by)).collect();
    let pinned: HashSet<Uuid> = pins.into_iter().map(|p| p.message_id).collect();

    // Saved-by-caller message ids.
    let saved: HashSet<Uuid> = user_saved_messages::Entity::find()
        .filter(user_saved_messages::Column::UserId.eq(caller))
        .filter(user_saved_messages::Column::MessageId.is_in(ids.clone()))
        .all(db)
        .await?
        .into_iter()
        .map(|s| s.message_id)
        .collect();

    // Link previews, one per message at most (see `unfurl`).
    let mut links: HashMap<Uuid, super::dto::LinkPreviewDto> =
        message_link_previews::Entity::find()
            .filter(message_link_previews::Column::MessageId.is_in(ids.clone()))
            .all(db)
            .await?
            .into_iter()
            .map(|row| {
                (
                    row.message_id,
                    super::dto::LinkPreviewDto {
                        image_url: row
                            .image_key
                            .as_ref()
                            .map(|_| format!("/api/v1/link-previews/{}/image", row.id)),
                        image_width: row.image_width,
                        image_height: row.image_height,
                        color: row.color,
                        url: row.url,
                        domain: row.domain,
                        title: row.title,
                        description: row.description,
                    },
                )
            })
            .collect();

    // Attachments, grouped by message (batch-loaded through the files module).
    let mut attachments = crate::files::attachments_for_messages(db, &ids)
        .await
        .map_err(|_| ApiError::Internal)?;

    // Who has answered in each thread, most recent first, capped: the feed draws their faces next to
    // the reply count without opening the thread. Only roots that have replies are asked about, and
    // only the authors are read back, so a long thread costs no more than a short one.
    let thread_ids: Vec<Uuid> = rows
        .iter()
        .filter(|m| m.reply_count > 0)
        .map(|m| m.id)
        .collect();
    let mut repliers: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    if !thread_ids.is_empty() {
        let reply_rows: Vec<(Option<Uuid>, Option<Uuid>)> = messages::Entity::find()
            .select_only()
            .column(messages::Column::ParentMessageId)
            .column(messages::Column::AuthorId)
            .filter(messages::Column::ParentMessageId.is_in(thread_ids))
            .filter(messages::Column::DeletedAt.is_null())
            .order_by_desc(messages::Column::CreatedAt)
            .order_by_desc(messages::Column::Id)
            .into_tuple()
            .all(db)
            .await?;
        for (parent_id, author_id) in reply_rows {
            let (Some(parent_id), Some(author_id)) = (parent_id, author_id) else {
                continue;
            };
            let faces = repliers.entry(parent_id).or_default();
            // One face per person: a thread where somebody answered themselves three times has one
            // participant, and saying so three times says nothing.
            if faces.len() < MAX_REPLY_FACES && !faces.contains(&author_id) {
                faces.push(author_id);
            }
        }
    }

    // Author display names, the repliers' included.
    let author_ids: Vec<Uuid> = rows
        .iter()
        .filter_map(|m| m.author_id)
        .chain(repliers.values().flatten().copied())
        .collect();
    let mut names: HashMap<Uuid, String> = HashMap::new();
    if !author_ids.is_empty() {
        for user in users::Entity::find()
            .filter(users::Column::Id.is_in(author_ids))
            .all(db)
            .await?
        {
            names.insert(user.id, user.display_name);
        }
    }

    let dtos = rows
        .into_iter()
        .map(|m| MessageDto {
            author_name: m.author_id.and_then(|id| names.get(&id).cloned()),
            reactions: reactions.remove(&m.id).unwrap_or_default(),
            mentions: mentions_by_msg.remove(&m.id).unwrap_or_default(),
            attachments: attachments.remove(&m.id).unwrap_or_default(),
            pinned: pinned.contains(&m.id),
            pinned_by: pinned_by.get(&m.id).copied().flatten(),
            saved: saved.contains(&m.id),
            edited: m.edited_at.is_some(),
            deleted: m.deleted_at.is_some(),
            imported: m.imported_source.is_some(),
            edited_at: m.edited_at.map(rfc3339),
            created_at: rfc3339(m.created_at),
            id: m.id,
            conversation_id: m.conversation_id,
            author_id: m.author_id,
            kind: m.kind,
            body: m.body,
            system_event: m.system_event,
            parent_message_id: m.parent_message_id,
            reply_authors: repliers
                .remove(&m.id)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|id| names.get(&id).cloned())
                .collect(),
            reply_count: m.reply_count,
            // A deleted message keeps nothing of what it said, its link included.
            link: if m.deleted_at.is_some() {
                None
            } else {
                links.remove(&m.id)
            },
        })
        .collect();

    Ok(dtos)
}

/// How many changes a catch-up sends as a list before telling the client to reload instead.
const MAX_CHANGES: u64 = 500;

/// How far back a catch-up reaches. Beyond it, reloading the space is cheaper and simpler than
/// replaying everything that happened.
const MAX_CATCH_UP: time::Duration = time::Duration::hours(24);

#[derive(Debug, Deserialize)]
pub struct ChangesQuery {
    /// RFC 3339, as returned in `now` by the previous call. Absent: only the cursor is returned.
    pub since: Option<String>,
}

/// `GET /api/v1/spaces/{space_id}/changes?since=`: what changed in the caller's conversations of a
/// space since a moment.
///
/// Real-time pushes are not replayed. A background tab is throttled or frozen by the browser and its
/// connection is often dropped; everything pushed meanwhile is lost, in every conversation, not only
/// the one on screen. This is what the client asks when it comes back: one request, whatever the
/// number of conversations, covering new messages, edits, deletions (tombstones) and new reactions,
/// thread replies included. A reaction taken back leaves no dated trace, so it is not here: the
/// client re-reads a conversation's latest page when it next opens it.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/{space_id}/changes",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("since" = Option<String>, Query, description = "RFC 3339 cursor from the previous call")
    ),
    responses(
        (status = 200, description = "What changed since then", body = super::dto::ChangesDto),
        (status = 400, description = "`since` is not an RFC 3339 instant"),
        (status = 403, description = "Not a member of the space")
    )
)]
pub async fn list_changes(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Query(query): Query<ChangesQuery>,
) -> Result<Json<super::dto::ChangesDto>, ApiError> {
    authz::ensure_space_member(&state.db, space_id, session.user_id).await?;
    let now = OffsetDateTime::now_utc();
    let answer = |messages, truncated| {
        Json(super::dto::ChangesDto {
            now: rfc3339(now),
            messages,
            truncated,
        })
    };
    let Some(since) = query.since else {
        return Ok(answer(Vec::new(), false));
    };
    let since = OffsetDateTime::parse(&since, &time::format_description::well_known::Rfc3339)
        .map_err(|_| ApiError::BadRequest("since is not an RFC 3339 instant"))?;
    if now - since > MAX_CATCH_UP {
        return Ok(answer(Vec::new(), true));
    }

    let conversations =
        authz::accessible_conversation_ids(&state.db, space_id, session.user_id).await?;
    if conversations.is_empty() {
        return Ok(answer(Vec::new(), false));
    }
    let reacted = sea_orm::sea_query::Query::select()
        .column(message_reactions::Column::MessageId)
        .from(message_reactions::Entity)
        .and_where(message_reactions::Column::CreatedAt.gt(since))
        .to_owned();
    let rows = messages::Entity::find()
        .filter(messages::Column::ConversationId.is_in(conversations))
        .filter(
            sea_orm::Condition::any()
                .add(messages::Column::CreatedAt.gt(since))
                .add(messages::Column::EditedAt.gt(since))
                .add(messages::Column::DeletedAt.gt(since))
                .add(messages::Column::Id.in_subquery(reacted)),
        )
        .order_by_asc(messages::Column::CreatedAt)
        .order_by_asc(messages::Column::Id)
        .limit(MAX_CHANGES + 1)
        .all(&state.db)
        .await?;
    if rows.len() as u64 > MAX_CHANGES {
        return Ok(answer(Vec::new(), true));
    }
    let messages = hydrate_messages(&state.db, session.user_id, rows).await?;
    Ok(answer(messages, false))
}
