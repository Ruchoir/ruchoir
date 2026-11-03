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
//! **A channel may be reserved to some roles.** `channel_role_access` holds one row per admitted
//! role, and no row at all means no restriction. It is an extra condition, not a replacement: the
//! channel type answers "who may join without being asked", the role list answers "who may be in it
//! at all". A leadership channel, or one an external guest never sees, is the second question. The
//! list is checked even for someone who already holds a membership row, so demoting a person takes
//! the channel away from them rather than leaving a door they walked through last week. The one
//! exception is the space's `owner`, who is admitted to every channel of their space whatever the
//! list says: a reservation is a rule about a room, never a way to lock somebody out of the space
//! they hold.
//!
//! **A `guest` inherits nothing.** For someone holding that role, every channel behaves like a
//! private one: they reach a conversation only where they hold an explicit row, public or not. That
//! single rule is what the role means, and everything else about guests follows from it rather than
//! being enforced a second time somewhere else: what they may list, search, mention, direct-message
//! and download all resolve through the helpers here. Before this, `guest` was a label the schema
//! accepted and no rule ever read, so an "external guest" saw exactly what a member saw.
//!
//! The audience helpers compute *who receives a push* for a conversation, evaluated once at publish
//! time so the real-time fan-out never queries the database on delivery.
//!
//! **Every rule above is decided by the permission engine** (`crate::permissions`): reading a
//! channel is `channel.view`, moderating it `message.manage`, `channel.members.manage` and
//! `channel.manage`, running the space the space-level permissions. The reservation, the guest rule
//! and the owner's reach are what the engine resolves from the roles, the rules converted from
//! `channel_role_access` and the standing; this module keeps the messaging-shaped questions and
//! their flat `403`. Direct messages stay a participant rule.

use std::collections::{BTreeSet, HashSet};

use sea_orm::{ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter};
use uuid::Uuid;

use super::error::ApiError;
use crate::entities::{
    channel_members, channel_role_access, channels, conversations, dm_conversations,
    dm_participants, space_members,
};
use crate::permissions::catalogue::Permission;
use crate::permissions::check::{self, Assume, Resource};
use crate::permissions::engine::Standing;

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
            // `channel.view`: a private channel is joined explicitly (the space's owner aside, who
            // reads it without joining), so is *every* channel for a guest, and a reservation keeps
            // out whoever it does not name, membership row or not.
            ensure_permission(
                db,
                conversation.space_id,
                user_id,
                Resource::Channel(conversation_id),
                Permission::ChannelView,
            )
            .await?;
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
/// a channel (those it still admits, see [`channel_audience`]), participants for a DM. Public-channel
/// readers who have not joined are intentionally excluded (they read history over REST but are not
/// pushed), matching the Slack model.
pub async fn conversation_audience(
    db: &DatabaseConnection,
    access: &ConversationAccess,
) -> Result<Vec<Uuid>, ApiError> {
    let ids = match access.kind {
        ConversationKind::Channel => channel_audience(db, access.conversation_id).await?,
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

/// The people a channel's content may be sent to: its `channel_members` rows, less whoever its role
/// reservation no longer admits.
///
/// A membership row outlives the right it once matched. Demoting someone, or reserving a channel
/// after people joined it, leaves their row in place on purpose (a promotion gives the room back with
/// their settings), and [`ensure_conversation_access`] refuses them the room all the same. Sending
/// to the rows alone delivered every new message, mention and reply notice to exactly the people the
/// reservation was drawn to keep out. Every push, notice and mention about a channel is addressed
/// through this list, so the room is read and heard by the same people.
pub async fn channel_audience<C: ConnectionTrait>(
    db: &C,
    channel_id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    let members: Vec<Uuid> = channel_members::Entity::find()
        .filter(channel_members::Column::ChannelId.eq(channel_id))
        .all(db)
        .await?
        .into_iter()
        .map(|member| member.user_id)
        .collect();
    if members.is_empty() {
        return Ok(members);
    }
    let Some(channel) = channels::Entity::find_by_id(channel_id).one(db).await? else {
        return Ok(Vec::new());
    };
    // Its readers (`channel.view`, resolved for the whole space at once): the same rule as
    // [`ensure_conversation_access`]. Someone with a row but no longer in the space reads nothing.
    let readers: HashSet<Uuid> =
        check::channel_holders(db, channel.space_id, channel_id, Permission::ChannelView)
            .await?
            .into_iter()
            .collect();
    Ok(members
        .into_iter()
        .filter(|user_id| readers.contains(user_id))
        .collect())
}

/// Whether a user may read a conversation, as a yes or no rather than a refusal.
///
/// For the one-person decisions that ride on a message without being a read of it: whether the
/// author of a thread's root still hears about its replies, for one. A database failure stays an
/// error rather than turning into a quiet "no".
pub async fn may_read(
    db: &DatabaseConnection,
    conversation_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    match ensure_conversation_access(db, conversation_id, user_id).await {
        Ok(_) => Ok(true),
        Err(ApiError::Forbidden) => Ok(false),
        Err(error) => Err(error),
    }
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

/// Require a permission (`crate::permissions`) on a resource of a space, or fail with the same flat
/// `403` whatever is missing: the space, the membership or the right.
pub async fn ensure_permission(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
    resource: Resource,
    permission: Permission,
) -> Result<(), ApiError> {
    if check::can(db, space_id, user_id, resource, permission).await? {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

/// The roles a space membership can hold, weakest first. The order is the rule: everything about who
/// may do what to whom is a comparison of two positions in this list, and the database constrains
/// `space_members.role` to exactly these four values.
pub const SPACE_ROLES: [&str; 4] = ["guest", "member", "admin", "owner"];

/// Where a role sits in [`SPACE_ROLES`]. An unknown string ranks lowest, which is the safe direction:
/// it can never authorise anything.
pub fn role_rank(role: &str) -> usize {
    SPACE_ROLES
        .iter()
        .position(|known| *known == role)
        .map(|index| index + 1)
        .unwrap_or(0)
}

/// Whether a string names a role the schema accepts.
pub fn is_space_role(role: &str) -> bool {
    SPACE_ROLES.contains(&role)
}

/// Require the `owner` role in the space, or fail with the same flat `403`.
///
/// The third guard of the space boundary, and the narrowest. [`ensure_space_member`] answers "may
/// they see this space", the space-level permissions "may they run it", this one "is it theirs". The line
/// between the last two is deliberate: an administrator manages the people and the conversations,
/// an owner holds the space itself, its identity, its end, and the billing the day that exists. Two
/// roles that could do exactly the same things would be one role with two names.
pub async fn ensure_space_owner(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    if is_space_owner(db, space_id, user_id).await? {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

/// The roles a channel membership can hold, weakest first. A shorter ladder than the space's: a
/// channel has no guests, because being in one is already the explicit thing a guest is given.
pub const CHANNEL_ROLES: [&str; 3] = ["member", "admin", "owner"];

/// Where a channel role sits in [`CHANNEL_ROLES`]; an unknown one ranks lowest.
pub fn channel_role_rank(role: &str) -> usize {
    CHANNEL_ROLES
        .iter()
        .position(|known| *known == role)
        .map(|index| index + 1)
        .unwrap_or(0)
}

/// Whether a string names a channel role the schema accepts.
pub fn is_channel_role(role: &str) -> bool {
    CHANNEL_ROLES.contains(&role)
}

/// What a caller counts as inside a channel: their channel role, or the top of the ladder when they
/// administer the space.
///
/// Someone who may archive a channel and delete anyone's message in it is already at the top of it;
/// pretending otherwise would mean a space administrator could moderate a channel but not say who
/// else may.
pub async fn effective_channel_rank(
    db: &DatabaseConnection,
    channel_id: Uuid,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<usize, ApiError> {
    // A guest moderates nothing, whatever the channel's own table says. Someone who opened a
    // channel and was later made a guest kept an `owner` row in it, and with it the right to add
    // and remove people in a space they are only visiting: the standing is the outer boundary, and
    // a demotion takes back what the old one opened.
    if check::standing(db, space_id, user_id).await? == Some(Standing::Guest) {
        return Ok(0);
    }
    // Whoever adds and removes people in every channel of the space is at the top of each.
    if check::can(
        db,
        space_id,
        user_id,
        Resource::Space,
        Permission::ChannelMembersManage,
    )
    .await?
    {
        return Ok(channel_role_rank("owner"));
    }
    Ok(channel_members::Entity::find_by_id((channel_id, user_id))
        .one(db)
        .await?
        .map(|member| channel_role_rank(&member.role))
        .unwrap_or(0))
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
    // Space by space, because the answer depends on the role held in each: a guest's presence is
    // exchanged with the people they share a conversation with, not with the whole organisation.
    // Without this, a guest's socket would receive a presence frame for every account in the space
    // and could enumerate it from ids alone, after the member list had been narrowed to stop exactly
    // that.
    let mut co: BTreeSet<Uuid> = BTreeSet::new();
    for space_id in space_ids {
        co.extend(visible_member_ids(db, space_id, user_id).await?);
    }
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

    let channel_ids: Vec<Uuid> = channels::Entity::find()
        .filter(channels::Column::SpaceId.eq(space_id))
        .all(db)
        .await?
        .into_iter()
        .map(|channel| channel.id)
        .collect();
    // Same rule as [`ensure_conversation_access`], and it has to be the same or search would find
    // what opening the conversation refuses to show: `channel.view`, for the whole space at once.
    let seen = check::effective_many(db, space_id, user_id, &channel_ids).await?;
    ids.extend(channel_ids.into_iter().filter(|id| {
        seen.get(id)
            .is_some_and(|granted| granted.contains(Permission::ChannelView))
    }));

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

/// The roles a channel admits, or `None` when it admits every role.
///
/// `None` and "every role listed" are the same thing to a reader, and deliberately not the same
/// thing in the table: a channel with no restriction was never given one, and gains nothing if the
/// set of roles changes later.
pub async fn channel_allowed_roles<C: ConnectionTrait>(
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

/// Whether the channel admits this person at all: its reservation (the rules converted from
/// `channel_role_access`) names their role, or they own the space.
///
/// True when the channel has no list, which is every channel until someone draws one.
pub async fn role_admitted(
    db: &DatabaseConnection,
    channel_id: Uuid,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    // Whether they would read it once in it: a space's owner is admitted to every channel in it,
    // named in the list or not (a reservation says who belongs in a room; it is not a way to take a
    // space away from the person who holds it), and it stays a real restriction for everybody else.
    Ok(check::sees_channel(
        db,
        space_id,
        user_id,
        channel_id,
        Assume {
            joined: Some(true),
            public: false,
        },
    )
    .await?)
}

/// The role a user holds in a space, or `None` when they are not in it.
pub async fn space_role(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Option<String>, ApiError> {
    Ok(space_members::Entity::find_by_id((space_id, user_id))
        .one(db)
        .await?
        .map(|member| member.role))
}

/// Whether a user holds the space: its owner, the one role that reads every channel in it.
///
/// A private channel is entered explicitly by everybody else, and stays invisible to whoever is not
/// in it. The owner answers for the whole space (its data, its members, what is said in it), so
/// they read a private channel without being in it, the way any member reads a public channel they
/// have not joined. Reading is all it grants: they are not pushed its messages and do not count
/// among its members until they join it.
pub async fn is_space_owner(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    Ok(check::standing(db, space_id, user_id).await? == Some(Standing::Owner))
}

/// The members of a space `user_id` may be shown: everyone, or for a guest, only the people they
/// share a conversation with (themselves included).
///
/// Used by the member list, the mention candidates, the direct-message candidates and the profile
/// endpoint. Restricting the conversations while publishing the roster would hand an outside
/// contractor the company directory, which is the thing "external guest" is chosen to avoid.
pub async fn visible_member_ids(
    db: &DatabaseConnection,
    space_id: Uuid,
    user_id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    // `members.view`: the whole directory. Without it (a guest), the people they share a
    // conversation with.
    if check::can(
        db,
        space_id,
        user_id,
        Resource::Space,
        Permission::MembersView,
    )
    .await?
    {
        return space_member_ids(db, space_id, user_id).await;
    }
    let conversations = accessible_conversation_ids(db, space_id, user_id).await?;
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
