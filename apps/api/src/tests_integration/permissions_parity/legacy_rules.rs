//! Today's authorization rules, kept verbatim as the oracle the engine is held to.
//!
//! Copied from `messaging/authz.rs`, `files/authz.rs` and `calendar/authz.rs` as they stood on the
//! commit the permission foundation's parity test was written on (67ec129), each renamed
//! `legacy_*`. They read the old columns (`space_members.role`, `channel_role_access`,
//! `calendars.write_access`), which keep being written through the whole foundation, so they stay
//! a valid oracle while the handlers move onto the engine. Never edit them to make the parity test
//! pass: a difference is the engine's to fix.

#![allow(dead_code)]

use std::collections::{BTreeSet, HashSet};

use sea_orm::{ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter};
use uuid::Uuid;

use crate::calendar::error::CalendarError;
use crate::entities::{
    calendars, channel_members, channel_role_access, channels, conversations, dm_conversations,
    dm_participants, files, message_attachments, messages, space_members,
};
use crate::files::authz::FileAccess;
use crate::files::error::FileError;
use crate::messaging::authz::{ConversationAccess, ConversationKind};
use crate::messaging::error::ApiError;

pub(super) const CHANNEL_ROLES: [&str; 3] = ["member", "admin", "owner"];
const LEGACY_SEEING_ROLES: [&str; 3] = ["member", "admin", "owner"];
const LEGACY_MANAGING_ROLES: [&str; 2] = ["admin", "owner"];

// ---- messaging/authz.rs ----

pub(super) async fn legacy_ensure_conversation_access(
    db: &DatabaseConnection,
    conversation_id: Uuid,
    user_id: Uuid,
) -> Result<ConversationAccess, ApiError> {
    let conversation = conversations::Entity::find_by_id(conversation_id)
        .one(db)
        .await?
        .ok_or(ApiError::Forbidden)?;

    match conversation.kind.as_str() {
        "channel" => {
            let channel = channels::Entity::find_by_id(conversation_id)
                .one(db)
                .await?
                .ok_or(ApiError::Forbidden)?;
            // A private channel is joined explicitly (its owner of the space aside, who reads it
            // without joining), and so is *every* channel for a guest: that is the whole of what
            // the role means. Both paths end at the same row.
            let explicit_only = (channel.channel_type == "private"
                && !legacy_is_space_owner(db, conversation.space_id, user_id).await?)
                || legacy_is_guest(db, conversation.space_id, user_id).await?;
            let authorized = if explicit_only {
                legacy_is_channel_member(db, conversation_id, user_id).await?
            } else {
                // Public and archived channels are open to any member of the space.
                legacy_is_space_member(db, conversation.space_id, user_id).await?
            };
            // And the channel's own guest list, when it has one, on top of all that.
            let admitted =
                legacy_role_admitted(db, conversation_id, conversation.space_id, user_id).await?;
            if !authorized || !admitted {
                return Err(ApiError::Forbidden);
            }
            Ok(ConversationAccess {
                conversation_id,
                space_id: conversation.space_id,
                kind: ConversationKind::Channel,
                channel_type: Some(channel.channel_type),
            })
        }
        "direct" => {
            if !legacy_is_dm_participant(db, conversation_id, user_id).await? {
                return Err(ApiError::Forbidden);
            }
            Ok(ConversationAccess {
                conversation_id,
                space_id: conversation.space_id,
                kind: ConversationKind::Direct,
                channel_type: None,
            })
        }
        _ => Err(ApiError::Internal),
    }
}

pub(super) async fn legacy_channel_allowed_roles<C: ConnectionTrait>(
    db: &C,
    channel_id: Uuid,
) -> Result<Option<BTreeSet<String>>, ApiError> {
    let rows = channel_role_access::Entity::find()
        .filter(channel_role_access::Column::ChannelId.eq(channel_id))
        .all(db)
        .await?;
    if rows.is_empty() {
        return Ok(None);
    }
    Ok(Some(rows.into_iter().map(|row| row.role).collect()))
}

pub(super) async fn legacy_role_admitted(
    db: &DatabaseConnection,
    channel_id: Uuid,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    let Some(allowed) = legacy_channel_allowed_roles(db, channel_id).await? else {
        return Ok(true);
    };
    let Some(role) = legacy_space_role(db, space_id, user_id).await? else {
        return Ok(false);
    };
    // A space's owner is admitted to every channel in it, named in the list or not. A reservation
    // says who belongs in a room; it is not a way to take a space away from the person who holds it.
    // Reserving a channel to the administrators used to make it vanish from the owner's own sidebar,
    // with no way back that did not go through the API. It stays a real restriction for everybody
    // else, and it still grants nothing on its own: a private channel is entered explicitly, owner
    // included.
    Ok(role == "owner" || allowed.contains(&role))
}

pub(super) async fn legacy_space_role(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Option<String>, ApiError> {
    Ok(space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await?
        .map(|member| member.role))
}

pub(super) async fn legacy_is_space_owner(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    Ok(legacy_space_role(db, space_id, user_id).await?.as_deref() == Some("owner"))
}

pub(super) async fn legacy_is_guest(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    Ok(legacy_space_role(db, space_id, user_id).await?.as_deref() == Some("guest"))
}

pub(super) async fn legacy_is_space_member(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    Ok(space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await?
        .is_some())
}

pub(super) async fn legacy_is_channel_member(
    db: &DatabaseConnection,
    channel_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    Ok(channel_members::Entity::find_by_id((channel_id, user_id))
        .one(db)
        .await?
        .is_some())
}

pub(super) async fn legacy_is_dm_participant(
    db: &DatabaseConnection,
    dm_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    Ok(dm_participants::Entity::find_by_id((dm_id, user_id))
        .one(db)
        .await?
        .is_some())
}

pub(super) async fn legacy_ensure_space_admin(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    match space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await?
    {
        Some(member) if member.role == "owner" || member.role == "admin" => Ok(()),
        _ => Err(ApiError::Forbidden),
    }
}

pub(super) async fn legacy_ensure_space_owner(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    match legacy_space_role(db, space_id, user_id).await?.as_deref() {
        Some("owner") => Ok(()),
        _ => Err(ApiError::Forbidden),
    }
}

pub(super) fn legacy_channel_role_rank(role: &str) -> usize {
    CHANNEL_ROLES
        .iter()
        .position(|known| *known == role)
        .map(|index| index + 1)
        .unwrap_or(0)
}

pub(super) async fn legacy_effective_channel_rank(
    db: &DatabaseConnection,
    channel_id: Uuid,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<usize, ApiError> {
    match legacy_space_role(db, space_id, user_id).await?.as_deref() {
        Some("owner") | Some("admin") => return Ok(legacy_channel_role_rank("owner")),
        // A guest moderates nothing, whatever the channel's own table says. Someone who opened a
        // channel and was later made a guest kept an `owner` row in it, and with it the right to
        // add and remove people in a space they are only visiting: the space role is the outer
        // boundary, and a demotion takes back what the old one opened.
        Some("guest") => return Ok(0),
        _ => {}
    }
    Ok(channel_members::Entity::find_by_id((channel_id, user_id))
        .one(db)
        .await?
        .map(|member| legacy_channel_role_rank(&member.role))
        .unwrap_or(0))
}

pub(super) async fn legacy_is_channel_moderator(
    db: &DatabaseConnection,
    channel_id: Uuid,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    // Same reason as in [`legacy_effective_channel_rank`]: a guest is in the space to take part, not to
    // run part of it, and a channel role they held before being demoted does not survive that.
    if legacy_is_guest(db, space_id, user_id).await? {
        return Ok(false);
    }
    if let Some(member) = channel_members::Entity::find_by_id((channel_id, user_id))
        .one(db)
        .await?
    {
        if member.role == "owner" || member.role == "admin" {
            return Ok(true);
        }
    }
    if let Some(member) = space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await?
    {
        if member.role == "owner" || member.role == "admin" {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) async fn legacy_visible_member_ids(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    if !legacy_is_guest(db, space_id, user_id).await? {
        return legacy_space_member_ids(db, space_id, user_id).await;
    }
    let conversations = legacy_accessible_conversation_ids(db, space_id, user_id).await?;
    let mut visible: BTreeSet<Uuid> = BTreeSet::new();
    visible.insert(user_id);
    if !conversations.is_empty() {
        let from_channels = channel_members::Entity::find()
            .filter(channel_members::Column::ChannelId.is_in(conversations.clone()))
            .all(db)
            .await?;
        visible.extend(from_channels.into_iter().map(|m| m.user_id));
        let from_dms = dm_participants::Entity::find()
            .filter(dm_participants::Column::DmId.is_in(conversations))
            .all(db)
            .await?;
        visible.extend(from_dms.into_iter().map(|p| p.user_id));
    }
    Ok(visible.into_iter().collect())
}

pub(super) async fn legacy_accessible_conversation_ids(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    if !legacy_is_space_member(db, space_id, user_id).await? {
        return Err(ApiError::Forbidden);
    }
    let mut ids = Vec::new();

    let joined_channels: HashSet<Uuid> = channel_members::Entity::find()
        .filter(channel_members::Column::UserId.eq(user_id))
        .all(db)
        .await?
        .into_iter()
        .map(|m| m.channel_id)
        .collect();
    let channels = channels::Entity::find()
        .filter(channels::Column::SpaceId.eq(space_id))
        .all(db)
        .await?;
    // Same rule as [`legacy_ensure_conversation_access`], and it has to be the same or search would find
    // what opening the conversation refuses to show.
    let explicit_only = legacy_is_guest(db, space_id, user_id).await?;
    let owner = legacy_is_space_owner(db, space_id, user_id).await?;
    for channel in channels {
        let open = !explicit_only && (channel.channel_type != "private" || owner);
        if !(open || joined_channels.contains(&channel.id)) {
            continue;
        }
        if legacy_role_admitted(db, channel.id, space_id, user_id).await? {
            ids.push(channel.id);
        }
    }

    let joined_dms: Vec<Uuid> = dm_participants::Entity::find()
        .filter(dm_participants::Column::UserId.eq(user_id))
        .all(db)
        .await?
        .into_iter()
        .map(|p| p.dm_id)
        .collect();
    if !joined_dms.is_empty() {
        let dms = dm_conversations::Entity::find()
            .filter(dm_conversations::Column::Id.is_in(joined_dms))
            .filter(dm_conversations::Column::SpaceId.eq(space_id))
            .all(db)
            .await?;
        for dm in dms {
            ids.push(dm.id);
        }
    }

    Ok(ids)
}

pub(super) async fn legacy_space_member_ids(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    if !legacy_is_space_member(db, space_id, user_id).await? {
        return Err(ApiError::Forbidden);
    }
    let ids = space_members::Entity::find()
        .filter(space_members::Column::SpaceId.eq(space_id))
        .all(db)
        .await?
        .into_iter()
        .map(|m| m.user_id)
        .collect();
    Ok(ids)
}

// ---- files/authz.rs ----

pub(super) async fn legacy_files_ensure_space_member(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<(), FileError> {
    space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await?
        .map(|_| ())
        .ok_or(FileError::Forbidden)
}

pub(super) async fn legacy_ensure_space_files_member(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<(), FileError> {
    legacy_files_ensure_space_member(db, space_id, user_id).await?;
    match legacy_is_guest(db, space_id, user_id).await {
        Ok(false) => Ok(()),
        Ok(true) => Err(FileError::Forbidden),
        Err(_) => Err(FileError::Internal),
    }
}

pub(super) async fn legacy_reaches_through_a_message(
    db: &DatabaseConnection,
    file_id: Uuid,
    user_id: Uuid,
) -> Result<bool, FileError> {
    let message_ids: Vec<Uuid> = message_attachments::Entity::find()
        .filter(message_attachments::Column::FileId.eq(file_id))
        .all(db)
        .await?
        .into_iter()
        .map(|attachment| attachment.message_id)
        .collect();
    if message_ids.is_empty() {
        return Ok(false);
    }
    let conversations: std::collections::BTreeSet<Uuid> = messages::Entity::find()
        .filter(messages::Column::Id.is_in(message_ids))
        .all(db)
        .await?
        .into_iter()
        .map(|message| message.conversation_id)
        .collect();
    for conversation_id in conversations {
        if legacy_conversation_access(db, conversation_id, user_id)
            .await
            .is_ok()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) async fn legacy_is_space_admin(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<bool, FileError> {
    Ok(space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await?
        .map(|m| m.role == "owner" || m.role == "admin")
        .unwrap_or(false))
}

pub(super) async fn legacy_conversation_access(
    db: &DatabaseConnection,
    conversation_id: Uuid,
    user_id: Uuid,
) -> Result<crate::messaging::authz::ConversationAccess, FileError> {
    legacy_ensure_conversation_access(db, conversation_id, user_id)
        .await
        .map_err(|error| match error {
            crate::messaging::error::ApiError::Internal => FileError::Internal,
            _ => FileError::Forbidden,
        })
}

pub(super) async fn legacy_ensure_readable(
    db: &DatabaseConnection,
    file_id: Uuid,
    user_id: Uuid,
) -> Result<FileAccess, FileError> {
    match legacy_readable_by_audience(db, file_id, user_id).await {
        Err(FileError::Forbidden)
            if crate::calendar::attachments::grants(db, file_id, user_id).await =>
        {
            let file = files::Entity::find_by_id(file_id)
                .one(db)
                .await?
                .ok_or(FileError::Forbidden)?;
            if file.deleted_at.is_some() {
                return Err(FileError::NotFound);
            }
            Ok(FileAccess {
                file,
                can_edit: false,
                through_event: true,
            })
        }
        other => other,
    }
}

pub(super) async fn legacy_readable_by_audience(
    db: &DatabaseConnection,
    file_id: Uuid,
    user_id: Uuid,
) -> Result<FileAccess, FileError> {
    let file = files::Entity::find_by_id(file_id)
        .one(db)
        .await?
        .ok_or(FileError::Forbidden)?;
    match file.conversation_id {
        // Attached to a private conversation: its participants are the audience, and nobody else.
        Some(conversation_id) => {
            legacy_conversation_access(db, conversation_id, user_id).await?;
        }
        None => {
            legacy_files_ensure_space_member(db, file.space_id, user_id).await?;
            // A space-tree file: open to the space, except to a guest, who only reaches it through
            // a message they can read.
            let guest = legacy_is_guest(db, file.space_id, user_id)
                .await
                .map_err(|_| FileError::Internal)?;
            if guest && !legacy_reaches_through_a_message(db, file.id, user_id).await? {
                return Err(FileError::Forbidden);
            }
        }
    }
    if file.deleted_at.is_some() {
        return Err(FileError::NotFound);
    }
    let can_edit =
        file.owner_id == Some(user_id) || legacy_is_space_admin(db, file.space_id, user_id).await?;
    Ok(FileAccess {
        file,
        can_edit,
        through_event: false,
    })
}

pub(super) async fn legacy_ensure_content_editable(
    db: &DatabaseConnection,
    file_id: Uuid,
    user_id: Uuid,
) -> Result<FileAccess, FileError> {
    let access = legacy_ensure_readable(db, file_id, user_id).await?;
    if access.file.kind == "folder" {
        return Err(FileError::BadRequest("a folder has no content to edit"));
    }
    // Reading a file through a calendar event is reading it, not working on it.
    if access.through_event {
        return Err(FileError::Forbidden);
    }
    let guest = legacy_is_guest(db, access.file.space_id, user_id)
        .await
        .map_err(|_| FileError::Internal)?;
    if guest {
        return Err(FileError::Forbidden);
    }
    Ok(access)
}

// ---- calendar/authz.rs ----

pub(super) async fn legacy_seeing_role<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Option<String>, CalendarError> {
    Ok(space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await?
        .map(|m| m.role)
        .filter(|role| LEGACY_SEEING_ROLES.contains(&role.as_str())))
}

/// `CalendarAccess::new`, verbatim: (can write events, can manage) for a space role, `None` being
/// the calendar's owner.
pub(super) fn legacy_calendar_rights(
    calendar: &calendars::Model,
    space_role: Option<String>,
) -> (bool, bool) {
    let (can_write_events, can_manage) = match space_role.as_deref() {
        None => (true, true),
        Some(role) => {
            let manages = LEGACY_MANAGING_ROLES.contains(&role);
            (manages || calendar.write_access == "members", manages)
        }
    };
    (can_write_events, can_manage)
}
