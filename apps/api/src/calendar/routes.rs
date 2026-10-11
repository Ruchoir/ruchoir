//! The calendar router. Absolute `/api/v1/...` paths, merged into the main router in `http.rs`.

use axum::routing::{get, patch, post, put};
use axum::Router;

use crate::state::AppState;

use super::{
    attachments, attendees, calendars, events, feeds, freebusy, links, occurrences, print, search,
    shares,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/calendars",
            get(calendars::list_calendars).post(calendars::create_personal_calendar),
        )
        .route(
            "/api/v1/spaces/{space_id}/calendars",
            post(calendars::create_space_calendar),
        )
        .route(
            "/api/v1/calendars/{calendar_id}",
            patch(calendars::update_calendar).delete(calendars::delete_calendar),
        )
        .route(
            "/api/v1/calendars/{calendar_id}/me",
            put(calendars::put_calendar_me),
        )
        .route(
            "/api/v1/calendars/{calendar_id}/events",
            post(events::create_event),
        )
        .route(
            "/api/v1/calendar/occurrences",
            get(occurrences::list_occurrences),
        )
        .route("/api/v1/calendar/search", get(search::search_events))
        .route("/api/v1/calendar/print", get(print::print))
        .route(
            "/api/v1/calendars/{calendar_id}/shares",
            get(shares::list_shares),
        )
        .route(
            "/api/v1/calendars/{calendar_id}/shares/{user_id}",
            put(shares::put_share).delete(shares::delete_share),
        )
        .route(
            "/api/v1/calendars/{calendar_id}/share-candidates",
            get(shares::share_candidates),
        )
        .route("/api/v1/calendar/freebusy", post(freebusy::free_busy))
        .route(
            "/api/v1/events/{event_id}",
            get(events::get_event)
                .patch(events::update_event)
                .delete(events::delete_event),
        )
        .route("/api/v1/events/{event_id}/me", put(events::put_event_me))
        .route("/api/v1/events/{event_id}/response", put(events::respond))
        .route(
            "/api/v1/calendars/{calendar_id}/invitees",
            get(attendees::search_invitees),
        )
        .route(
            "/api/v1/calendars/{calendar_id}/channels",
            get(links::list_linkable),
        )
        .route("/api/v1/channels/{channel_id}/events", get(links::upcoming))
        .route(
            "/api/v1/calendars/{calendar_id}/attachment-folder",
            get(attachments::attachment_folder),
        )
        .route(
            "/api/v1/calendar/feeds",
            get(feeds::list_feeds).post(feeds::create_feed),
        )
        .route(
            "/api/v1/calendar/feeds/{feed_id}",
            axum::routing::delete(feeds::revoke_feed),
        )
}
