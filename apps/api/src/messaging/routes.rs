//! The messaging router: messages, threads, reactions, read cursors, pins, saved and DMs.
//!
//! Routes use absolute `/api/v1/...` paths and are merged into the main router in `http.rs`
//! (alongside the existing `/api/v1/health` route and the `/api/v1/auth` nest), which avoids the
//! path-overlap a second `/api/v1` nest would introduce.

use axum::routing::{delete, get, patch, post, put};
use axum::Router;

use crate::state::AppState;

use super::{
    channels, conversations, invitations, messages, notifications, pins, reactions, read, saved,
    search, spaces, users,
};

/// Build the messaging sub-router.
pub fn router() -> Router<AppState> {
    Router::new()
        // Messages and threads.
        .route(
            "/api/v1/conversations/{conversation_id}/messages",
            get(messages::list_messages).post(messages::send_message),
        )
        .route(
            "/api/v1/messages/{message_id}/replies",
            get(messages::list_replies),
        )
        .route(
            "/api/v1/messages/{message_id}",
            patch(messages::edit_message).delete(messages::delete_message),
        )
        // Reactions.
        .route(
            "/api/v1/messages/{message_id}/reactions/{emoji}",
            put(reactions::add_reaction).delete(reactions::remove_reaction),
        )
        // Read cursor.
        .route(
            "/api/v1/conversations/{conversation_id}/read",
            get(read::get_read_cursors).put(read::set_read_cursor),
        )
        // Pins.
        .route("/api/v1/channels/{channel_id}/pins", get(pins::list_pins))
        .route(
            "/api/v1/channels/{channel_id}/pins/{message_id}",
            put(pins::pin_message).delete(pins::unpin_message),
        )
        // Saved messages.
        .route("/api/v1/me/saved", get(saved::list_saved))
        .route(
            "/api/v1/messages/{message_id}/save",
            put(saved::save_message).delete(saved::unsave_message),
        )
        // Spaces the caller belongs to (SPA bootstrap), and creating one.
        .route("/api/v1/me/spaces", get(conversations::list_my_spaces))
        .route("/api/v1/spaces", post(spaces::create_space))
        .route("/api/v1/spaces/{space_id}", patch(spaces::update_space))
        .route(
            "/api/v1/spaces/by-slug/{slug}",
            get(spaces::resolve_space_slug),
        )
        // Space invitations: issuing and listing need an owner/admin role, accepting only a
        // session, and the preview none at all (the invitee has not signed in yet).
        .route(
            "/api/v1/spaces/{space_id}/invitations",
            get(invitations::list_invitations).post(invitations::create_invitation),
        )
        .route(
            "/api/v1/spaces/{space_id}/invitations/{invitation_id}",
            delete(invitations::revoke_invitation),
        )
        .route(
            "/api/v1/invitations/{token}",
            get(invitations::preview_invitation),
        )
        .route(
            "/api/v1/invitations/{token}/accept",
            post(invitations::accept_invitation),
        )
        // A member's profile (profile card, member list), and editing one's own.
        .route("/api/v1/users/me", patch(users::update_my_profile))
        .route("/api/v1/users/{user_id}", get(users::get_user_profile))
        // Channels, DMs and DM creation.
        .route(
            "/api/v1/spaces/{space_id}/channels",
            get(conversations::list_channels).post(channels::create_channel),
        )
        // Channel lifecycle: settings and archiving, then the caller's own membership.
        .route(
            "/api/v1/channels/{channel_id}",
            patch(channels::update_channel),
        )
        .route(
            "/api/v1/channels/{channel_id}/membership",
            put(channels::join_channel).delete(channels::leave_channel),
        )
        .route(
            "/api/v1/spaces/{space_id}/dms",
            get(conversations::list_dms),
        )
        .route(
            "/api/v1/spaces/{space_id}/members",
            get(conversations::list_members),
        )
        .route(
            "/api/v1/spaces/{space_id}/dm",
            post(conversations::create_dm),
        )
        // Full-text search over messages and file names.
        .route("/api/v1/search", get(search::search))
        // In-app notification feed.
        .route(
            "/api/v1/notifications",
            get(notifications::list_notifications),
        )
        .route(
            "/api/v1/notifications/read",
            put(notifications::mark_all_read),
        )
        .route(
            "/api/v1/notifications/{id}/read",
            put(notifications::mark_read),
        )
}
