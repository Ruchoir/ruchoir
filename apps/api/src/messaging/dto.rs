//! Response and request shapes for the messaging surface.
//!
//! These are kept deliberately close to the web data seam (`apps/web/lib/data/types.ts`) so wiring
//! the client to the real API later is mechanical: a `MessageDto` carries its reactions (with the
//! derived `count`/`mine`), thread `reply_count`, the edited/deleted/pinned/saved flags and resolved
//! mention ids. Unlike the mock, ids are real UUIDs and timestamps are RFC 3339 strings.

use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::files::AttachmentDto;

/// A reaction bucket on a message: the emoji, how many reacted, and whether the caller did.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ReactionDto {
    /// Native Unicode emoji.
    pub emoji: String,
    /// Total reactors for this emoji.
    pub count: i64,
    /// Whether the current caller is one of them (drives the toggle highlight).
    pub mine: bool,
    /// Display names of the reactors, in first-reaction order (for the "who reacted" tooltip).
    pub users: Vec<String>,
}

/// A message as returned to clients, with its satellites folded in.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MessageDto {
    pub id: Uuid,
    pub conversation_id: Uuid,
    /// `None` for system messages.
    pub author_id: Option<Uuid>,
    /// Author display name, denormalized for direct rendering; `None` for system messages.
    pub author_name: Option<String>,
    /// `message` or `system`.
    pub kind: String,
    /// Raw markdown (rendered client-side). Blank for a deleted tombstone.
    pub body: String,
    /// System-event discriminator for `system` messages (join/leave and similar).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_event: Option<String>,
    /// Parent message for a threaded reply; `None` for a root message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<Uuid>,
    /// Number of replies in this message's thread.
    pub reply_count: i32,
    /// Whether the message was migrated from another tool.
    pub imported: bool,
    /// Whether the message was edited.
    pub edited: bool,
    /// Whether the message is a deleted tombstone.
    pub deleted: bool,
    /// Whether the message is pinned in its channel.
    pub pinned: bool,
    /// Whether the caller saved (bookmarked) this message.
    pub saved: bool,
    /// RFC 3339 creation timestamp.
    pub created_at: String,
    /// RFC 3339 edit timestamp, when edited.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
    /// Reaction buckets, sorted by first appearance.
    pub reactions: Vec<ReactionDto>,
    /// Resolved mention target user ids.
    pub mentions: Vec<Uuid>,
    /// Files attached to the message, in attachment order.
    pub attachments: Vec<AttachmentDto>,
}

/// A page of messages, newest-last, with an opaque cursor for the previous (older) page.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MessagePage {
    pub messages: Vec<MessageDto>,
    /// Pass as `before` to fetch the next older page; `None` when the start was reached.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_before: Option<Uuid>,
}

/// A space the caller belongs to: the workspace-switcher entry and the bootstrap the SPA needs to
/// discover its channels (which are queried per space).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SpaceDto {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    /// The caller's role in the space: `owner`, `admin`, `member` or `guest`.
    pub role: String,
    /// Total members in the space (drives the workspace member count in the UI).
    pub members: i64,
}

/// A channel in a space's sidebar list.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ChannelDto {
    pub id: Uuid,
    pub name: String,
    /// `public`, `private` or `archived`.
    #[serde(rename = "type")]
    pub channel_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported: Option<String>,
    /// Per-user sidebar favourite.
    pub favorite: bool,
    /// Whether the caller has joined this channel. A public channel is readable either way, but only
    /// members are pushed to in real time, so the client offers "join" or "leave" accordingly.
    pub member: bool,
    /// Count of unread messages for the caller (derived from the read cursor).
    pub unread: i64,
}

/// A direct-message conversation in a space's sidebar list.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DirectMessageDto {
    pub id: Uuid,
    /// Display label: the other participant, or a comma-joined list for a group.
    pub name: String,
    pub is_group: bool,
    /// The sole counterpart's user id for a 1:1 DM, so the client can overlay their live presence;
    /// `None` for a group DM (no single counterpart to track).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<Uuid>,
    /// Whether the sole counterpart is a bot account.
    pub bot: bool,
    pub unread: i64,
}

/// A user's effective presence as seen by others.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PresenceDto {
    pub user_id: Uuid,
    /// `active`, `away`, `dnd` or `offline`.
    pub presence: String,
}

/// A member's global profile, as shown in the profile card and member list. Presence is not folded
/// in here: it is volatile and sourced separately (`GET /spaces/{id}/presence` and realtime events),
/// so this stays the stable, self-editable profile. Returned only for a user who shares a space with
/// the caller.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct UserProfileDto {
    pub id: Uuid,
    pub display_name: String,
    pub email: String,
    /// Free-text job title / role label (e.g. "Gérante"); `None` if unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pronouns: Option<String>,
    /// IANA timezone (e.g. "Europe/Paris"); the client derives the local time from it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    /// Whether this is a service account (e.g. the import assistant).
    pub is_bot: bool,
}

/// A space member row: identity plus the caller-independent role in the space. Presence is overlaid
/// client-side from the presence map, so it is not carried here.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MemberDto {
    pub user_id: Uuid,
    pub display_name: String,
    /// Free-text job title / role label; `None` if unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Membership role in the space: `owner`, `admin`, `member` or `guest`.
    pub role: String,
    pub is_bot: bool,
}

/// Edit the caller's own profile. Absent fields are left unchanged; an empty string clears the field
/// (except `display_name`, which is required and ignored when blank).
#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateProfileRequest {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub pronouns: Option<String>,
    #[serde(default)]
    pub bio: Option<String>,
}

// --- Search & notifications ---

/// One in-app notification in the caller's inbox.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct NotificationDto {
    pub id: Uuid,
    /// `mention`, `reply` or `dm`.
    pub kind: String,
    pub conversation_id: Uuid,
    pub message_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_name: Option<String>,
    /// A short plain-text excerpt of the source message.
    pub preview: String,
    pub created_at: String,
    /// Whether the caller has read the notification.
    pub read: bool,
}

/// A page of notifications, newest first, with the caller's total unread count.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct NotificationPage {
    pub notifications: Vec<NotificationDto>,
    /// Cursor for the next (older) page, or `None` at the end.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_before: Option<Uuid>,
    pub unread_count: i64,
}

/// A file matched by a search, enough to render a result row and open it.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FileHitDto {
    pub id: Uuid,
    pub name: String,
    /// `file`, `folder`, `image`, ...
    pub kind: String,
}

/// Combined search results: matching messages and file names the caller can see.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SearchResults {
    pub messages: Vec<MessageDto>,
    pub files: Vec<FileHitDto>,
}

// --- Request bodies ---

/// Post a new message (optionally as a threaded reply).
#[derive(Debug, Deserialize, ToSchema)]
pub struct SendMessageRequest {
    pub body: String,
    #[serde(default)]
    pub parent_message_id: Option<Uuid>,
    /// Ids of already-uploaded files to attach (the caller must be able to read each, and each must
    /// belong to the conversation's space).
    #[serde(default)]
    pub attachments: Vec<Uuid>,
}

/// Edit an existing message.
#[derive(Debug, Deserialize, ToSchema)]
pub struct EditMessageRequest {
    pub body: String,
}

/// Advance the caller's read cursor in a conversation.
#[derive(Debug, Deserialize, ToSchema)]
pub struct ReadRequest {
    pub last_read_message_id: Uuid,
}

/// Open (or fetch) a direct-message conversation with a set of users.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateDmRequest {
    /// The other participant(s); the caller is added implicitly.
    pub user_ids: Vec<Uuid>,
}

/// A new space to create. The caller becomes its owner.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateSpaceRequest {
    /// Display name. The URL slug is derived from it and made unique.
    pub name: String,
}

/// A new channel to create in a space.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateChannelRequest {
    /// Display name; normalised to the lowercase, dash-separated form channels use.
    pub name: String,
    /// `public` or `private`. A channel cannot be created already archived.
    #[serde(rename = "type")]
    pub channel_type: String,
    #[serde(default)]
    pub topic: Option<String>,
}

/// Fields to change on a channel. An absent field is left untouched; an empty `topic` clears it.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateChannelRequest {
    #[serde(default)]
    pub name: Option<String>,
    /// `public`, `private` or `archived`. Moving to `archived` makes the channel read-only.
    #[serde(default, rename = "type")]
    pub channel_type: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
}

/// A reference to a just-created or fetched conversation.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ConversationRef {
    pub id: Uuid,
}

/// Set (or clear) the caller's manual presence override.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SetPresenceRequest {
    /// `active`, `away`, `dnd`, `invisible`, or `null`/absent to return to automatic presence.
    #[serde(default)]
    pub manual_presence: Option<String>,
}

/// A typing signal for a conversation (SSE-fallback clients POST this; WS clients send it inline).
#[derive(Debug, Deserialize, ToSchema)]
pub struct TypingRequest {
    pub conversation_id: Uuid,
}

/// Format an `OffsetDateTime` as RFC 3339, falling back to an empty string on the impossible error.
pub fn rfc3339(ts: OffsetDateTime) -> String {
    ts.format(&Rfc3339).unwrap_or_default()
}
