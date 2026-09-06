//! Conversation authorization: the single membership choke point for messaging.
//!
//! Every read and write resolves through [`ensure_conversation_access`] first, so a handler that
//! holds a [`ConversationAccess`] is authorized by construction, the same discipline the auth guard
//! uses for identity. The rules mirror the seed's model:
//!
//! - **Public / archived channels** are readable by any member of the owning space.
//! - **Private channels** require an explicit `channel_members` row.
//! - **Direct messages** require a `dm_participants` row.
//!
//! The audience helpers compute *who receives a push* for a conversation, evaluated once at publish
//! time so the real-time fan-out never queries the database on delivery.

use std::collections::{BTreeSet, HashSet};

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use uuid::Uuid;

use super::error::ApiError;
use crate::entities::{
    channel_members, channels, conversations, dm_conversations, dm_participants, space_members,
};

/// Whether a conversation is a channel or a direct message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversationKind {
    Channel,
    Direct,
}

/// A resolved, authorized handle to a conversation the caller may access.
#[derive(Debug, Clone)]
pub struct ConversationAccess {
    pub conversation_id: Uuid,
    pub space_id: Uuid,
    pub kind: ConversationKind,
    /// For channels, the channel type (`public`, `private`, `archived`); `None` for DMs.
    pub channel_type: Option<String>,
}

impl ConversationAccess {
    /// Whether new messages may be posted here. Archived channels are read-only.
    pub fn is_postable(&self) -> bool {
        self.channel_type.as_deref() != Some("archived")
    }
}

/// Resolve and authorize a conversation for a caller, or fail with `403` (never revealing whether
/// the conversation exists to someone who cannot see it).
pub async fn ensure_conversation_access(
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
            let is_private = channel.channel_type == "private";
            let authorized = if is_private {
                is_channel_member(db, conversation_id, user_id).await?
            } else {
                // Public and archived channels are open to any member of the space.
                is_space_member(db, conversation.space_id, user_id).await?
            };
            if !authorized {
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
            if !is_dm_participant(db, conversation_id, user_id).await? {
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

/// The set of user ids that should receive a real-time push for a conversation: channel members for
/// a channel, participants for a DM. Public-channel readers who have not joined are intentionally
/// excluded (they read history over REST but are not pushed), matching the Slack model.
pub async fn conversation_audience(
    db: &DatabaseConnection,
    access: &ConversationAccess,
) -> Result<Vec<Uuid>, ApiError> {
    let ids = match access.kind {
        ConversationKind::Channel => channel_members::Entity::find()
            .filter(channel_members::Column::ChannelId.eq(access.conversation_id))
            .all(db)
            .await?
            .into_iter()
            .map(|m| m.user_id)
            .collect(),
        ConversationKind::Direct => dm_participants::Entity::find()
            .filter(dm_participants::Column::DmId.eq(access.conversation_id))
            .all(db)
            .await?
            .into_iter()
            .map(|p| p.user_id)
            .collect(),
    };
    Ok(ids)
}

/// Require space membership, or fail with a flat `403` that does not reveal whether the space
/// exists. The entry guard of every space-scoped handler.
pub async fn ensure_space_member(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    if is_space_member(db, space_id, user_id).await? {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

/// Whether the caller may moderate a channel (delete others' messages, pin): an `owner`/`admin`
/// channel role, or an `owner`/`admin` role in the owning space.
pub async fn is_channel_moderator(
    db: &DatabaseConnection,
    channel_id: Uuid,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
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

/// Every user who shares at least one space with `user_id`, including the user. Drives presence
/// fan-out: a presence change is visible to a user's space co-members.
pub async fn space_co_members(
    db: &DatabaseConnection,
    user_id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    let space_ids: Vec<Uuid> = space_members::Entity::find()
        .filter(space_members::Column::UserId.eq(user_id))
        .all(db)
        .await?
        .into_iter()
        .map(|m| m.space_id)
        .collect();
    if space_ids.is_empty() {
        return Ok(vec![user_id]);
    }
    let mut co: BTreeSet<Uuid> = space_members::Entity::find()
        .filter(space_members::Column::SpaceId.is_in(space_ids))
        .all(db)
        .await?
        .into_iter()
        .map(|m| m.user_id)
        .collect();
    co.insert(user_id);
    Ok(co.into_iter().collect())
}

/// The ids of every conversation in a space the caller may read: visible channels (public and
/// archived, plus private channels they have joined) and their direct messages. Used to scope
/// search to what the caller can already see. Fails `403` if they are not a member of the space.
pub async fn accessible_conversation_ids(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    if !is_space_member(db, space_id, user_id).await? {
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
    for channel in channels {
        if channel.channel_type != "private" || joined_channels.contains(&channel.id) {
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

/// The user ids of a space's members (used for a presence snapshot).
pub async fn space_member_ids(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    if !is_space_member(db, space_id, user_id).await? {
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

/// Whether a user belongs to a space. Space membership is the outer boundary: every channel and DM
/// rule below sits inside it.
pub async fn is_space_member(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    Ok(space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await?
        .is_some())
}

async fn is_channel_member(
    db: &DatabaseConnection,
    channel_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    Ok(channel_members::Entity::find_by_id((channel_id, user_id))
        .one(db)
        .await?
        .is_some())
}

async fn is_dm_participant(
    db: &DatabaseConnection,
    dm_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    Ok(dm_participants::Entity::find_by_id((dm_id, user_id))
        .one(db)
        .await?
        .is_some())
}
