//! Preferences that follow a person from one device to another.
//!
//! They used to live in each browser's `localStorage` (and in the phone's secure store), so a
//! language chosen on the laptop, a rail arranged at the office or a conversation hidden on the
//! phone stayed where it was done. The server now holds the ones that describe how a person
//! organises Ruchoir, in `user_preferences`, and tells their other open devices when one changes.
//!
//! What describes the screen rather than the person stays on the device, by decision (2026-11-03):
//! the theme (accent, day or night), the text size, the thread panel's width, and whether this
//! browser already asked for the notification permission. Notification settings have their own
//! route (`crate::notify::prefs`), and hidden direct conversations their own column
//! (`dm_participants.hidden`, see `crate::messaging::conversations`).
//!
//! - [`document`]: the closed list of keys, what each accepts, and how a change merges.
//! - [`routes`]: `GET` and `PATCH /api/v1/me/preferences`.

pub mod document;
pub mod routes;

use axum::routing::get;
use axum::Router;

use crate::state::AppState;

/// The preferences routes. Merged into the main router with absolute paths.
pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/v1/me/preferences",
        get(routes::get_preferences).patch(routes::patch_preferences),
    )
}
