//! Reaching someone who is not looking at Ruchoir.
//!
//! The inbox itself (`crate::messaging::notifications`) is written inside the send transaction and
//! pushed over the real-time hub, which reaches every open page. This module is everything past
//! that point, for the person with no page open:
//!
//! - [`prefs`]: the notification preferences, held server-side so the server can obey them.
//! - [`push`], [`vapid`] and [`ece`]: Web Push to browsers that subscribed (ADR 0001), carrying a
//!   constant encrypted marker and never any content.
//! - [`email`]: the digest of what is still unread after a while, through the instance's own relay.
//!
//! All three read the same rule ([`prefs::allows`]) so the app, the phone and the mailbox agree on
//! what was worth saying.

pub mod ece;
pub mod email;
pub mod prefs;
pub mod push;
pub mod vapid;

use axum::routing::{get, post, put};
use axum::Router;

use crate::state::AppState;

/// The notification-delivery routes. Merged into the main router with absolute paths.
pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/me/notification-preferences",
            get(prefs::get_preferences).put(prefs::put_preferences),
        )
        .route(
            "/api/v1/conversations/{conversation_id}/notification-preference",
            put(prefs::put_conversation_preference),
        )
        .route(
            "/api/v1/spaces/{space_id}/notification-preference",
            put(prefs::put_space_preference),
        )
        .route("/api/v1/push/config", get(push::config))
        .route(
            "/api/v1/push/subscription",
            put(push::subscribe).delete(push::unsubscribe),
        )
        .route("/api/v1/push/pending", get(push::pending))
        .route("/api/v1/push/test", post(push::test))
}
