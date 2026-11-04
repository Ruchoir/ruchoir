//! "View as a role": a session looks at one space as if it held only a chosen role.
//!
//! The mode lives in Valkey under `preview:<session id>`, so it belongs to one session (another
//! session of the same person, on another device, is untouched) and ends with it. A middleware
//! reads it once per request, after the session id is known, and scopes it to the request as a
//! task-local; the loader ([`super::load`]) is the only reader of that task-local. Two consequences
//! are deliberate:
//!
//! - **One door.** The same middleware refuses every request that is not a read, and the realtime
//!   transports, with `403 preview_read_only`. No handler knows about previews.
//! - **Nothing escapes the request.** A task-local is not inherited by `tokio::spawn`, so work a
//!   request starts for later (fan-out, notifications, jobs) resolves rights normally.
//!
//! The preview is idle when nobody acts: every request refreshes a 30 minute timer, except the
//! realtime and heartbeat paths, which a page sends without a human behind them.

use axum::extract::{Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use fred::interfaces::KeysInterface;
use fred::prelude::Pool;
use fred::types::Expiration;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::session;
use crate::config::Config;
use crate::state::AppState;

const KEY_PREFIX: &str = "preview:";

/// What a session is previewing: one role, in one space, for one person.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewState {
    pub space_id: Uuid,
    pub role_id: Uuid,
    pub role_name: String,
    /// The person whose session it is: the only one whose rights the preview changes.
    pub user_id: Uuid,
}

/// What a space tells its viewer while a preview is on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct PreviewDto {
    pub role_id: Uuid,
    pub role_name: String,
}

tokio::task_local! {
    /// The preview of the request being served, set by [`guard`] and read by the loader alone.
    static PREVIEW: PreviewState;
}

/// A session is signing out (or being signed out): its preview ends with it, and the log says so.
/// An idle end, the key lapsing in Valkey, is not logged: the "ended" lines come from the person
/// leaving the preview or signing out. Best effort: signing out must not fail on the log.
pub(crate) async fn end_on_sign_out(state: &AppState, session_id: &str, user_id: Uuid) {
    let current = match current(&state.valkey, session_id).await {
        Ok(Some(current)) => current,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!(%error, "could not read the preview of a session signing out");
            return;
        }
    };
    if let Err(error) = stop(&state.valkey, session_id).await {
        tracing::warn!(%error, "could not end the preview of a session signing out");
    }
    if let Err(error) = crate::audit::record(
        &state.db,
        current.space_id,
        Some(user_id),
        crate::audit::Action::RolePreviewed,
        crate::audit::Target::Role(current.role_id),
        serde_json::json!({
            "role_id": current.role_id,
            "role_name": current.role_name,
            "phase": "ended",
            "reason": "signed_out",
        }),
    )
    .await
    {
        tracing::warn!(%error, "the end of a preview was not logged");
    }
}

fn key(session_id: &str) -> String {
    format!("{KEY_PREFIX}{session_id}")
}

/// Start (or replace) the preview of a session. The caller has already checked that the person may
/// preview this role; nothing here does.
pub async fn start(
    valkey: &Pool,
    config: &Config,
    session_id: &str,
    state: &PreviewState,
) -> Result<(), fred::error::Error> {
    let json = serde_json::to_string(state).expect("a preview serializes");
    valkey
        .set(
            key(session_id),
            json,
            Some(Expiration::EX(config.preview_idle_ttl_secs)),
            None,
            false,
        )
        .await
}

/// End the preview of a session. Idempotent.
pub async fn stop(valkey: &Pool, session_id: &str) -> Result<(), fred::error::Error> {
    valkey.del::<(), _>(key(session_id)).await
}

/// The preview of a session, when there is one. Does not touch the idle timer.
pub async fn current(
    valkey: &Pool,
    session_id: &str,
) -> Result<Option<PreviewState>, fred::error::Error> {
    let json: Option<String> = valkey.get(key(session_id)).await?;
    Ok(json.and_then(|json| serde_json::from_str(&json).ok()))
}

/// The preview of the request being served, if it is for `space_id`.
pub(crate) fn of_space(space_id: Uuid) -> Option<PreviewState> {
    PREVIEW
        .try_with(|preview| preview.clone())
        .ok()
        .filter(|preview| preview.space_id == space_id)
}

/// What the space DTO says: the role being previewed in this space, if any.
pub(crate) fn dto_of_space(space_id: Uuid) -> Option<PreviewDto> {
    of_space(space_id).map(|preview| PreviewDto {
        role_id: preview.role_id,
        role_name: preview.role_name,
    })
}

/// Run `work` as a request of `preview` would: what the middleware does around a handler.
#[cfg(test)]
pub(crate) async fn within<F: std::future::Future>(preview: PreviewState, work: F) -> F::Output {
    PREVIEW.scope(preview, work).await
}

/// The paths a page sends without anyone acting: they never push the idle timer back. Presence is
/// the only polled read (`GET /spaces/{id}/presence`); the heartbeats and typing signals are
/// writes, which a preview refuses before they could count.
fn is_background(path: &str) -> bool {
    path.starts_with("/api/v1/realtime/") || path.ends_with("/presence")
}

/// The realtime transports: each would keep delivering the real events (fan-out is computed per
/// recipient outside the previewing request), so a previewing session gets none.
fn is_realtime(path: &str) -> bool {
    path.starts_with("/api/v1/realtime/")
}

/// What a previewing session may still write: leaving the preview, and signing out.
fn is_exit(method: &Method, path: &str) -> bool {
    if *method == Method::POST {
        return path == "/api/v1/auth/logout" || path == "/api/v1/auth/logout/all";
    }
    if *method != Method::DELETE {
        return false;
    }
    let mut parts = path.trim_matches('/').split('/');
    matches!(
        (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next()
        ),
        (
            Some("api"),
            Some("v1"),
            Some("spaces"),
            Some(id),
            Some("preview"),
            None
        ) if Uuid::parse_str(id).is_ok()
    )
}

fn refusal() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "error": "preview_read_only",
            "message": "A preview is read only: leave it to make changes.",
        })),
    )
        .into_response()
}

/// The one door. For a session that is previewing: refuse the realtime transports and every request
/// that is not a read (but leaving the preview and signing out), keep the idle timer running, and
/// scope the preview to the request so the loader resolves rights through it. Everyone else goes
/// straight through, at the cost of one Valkey read for a request that carries a session.
pub(crate) async fn guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    // Pages and assets are served to everyone; only the API has rights to resolve.
    if !req.uri().path().starts_with("/api/") {
        return next.run(req).await;
    }
    let Some(session_id) = session::presented_id(req.headers()) else {
        return next.run(req).await;
    };
    let background = is_background(req.uri().path());
    // A refused write is not activity: the person is not doing anything.
    let reads = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let allowed = reads || is_exit(req.method(), req.uri().path());
    let found: Result<Option<String>, _> = state.valkey.get(key(&session_id)).await;
    let preview = match found {
        Ok(None) => return next.run(req).await,
        Ok(Some(json)) => serde_json::from_str::<PreviewState>(&json).ok(),
        Err(error) => {
            tracing::warn!(%error, "could not read the preview of a session");
            None
        }
    };
    let Some(preview) = preview else {
        // The state could not be read or understood, so whether this session previews is unknown:
        // a read goes on as an ordinary request, a write is not let through on a guess. A read let
        // through this way shows the viewer's own full rights, never more than they hold (an
        // accepted limit, ruled in the security review of lot 4: a write is what a preview must keep
        // shut, and that fails closed just below).
        return if allowed {
            next.run(req).await
        } else {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": "preview_unavailable",
                    "message": "The preview state could not be read: try again.",
                })),
            )
                .into_response()
        };
    };
    if is_realtime(req.uri().path()) || !allowed {
        return refusal();
    }
    if !background {
        // Best effort: if the key lapsed in between, the next request simply is not a preview.
        let _: Result<bool, _> = state
            .valkey
            .expire(key(&session_id), state.config.preview_idle_ttl_secs, None)
            .await;
    }
    PREVIEW.scope(preview, next.run(req)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_leaving_and_signing_out_are_writes_a_preview_allows() {
        let space = Uuid::new_v4();
        let leave = format!("/api/v1/spaces/{space}/preview");
        assert!(is_exit(&Method::DELETE, &leave));
        assert!(!is_exit(&Method::POST, &leave));
        assert!(!is_exit(&Method::PUT, &leave));
        assert!(!is_exit(&Method::DELETE, &format!("{leave}/more")));
        assert!(!is_exit(&Method::DELETE, "/api/v1/spaces/x/preview"));
        assert!(!is_exit(
            &Method::DELETE,
            &format!("/api/v1/spaces/{space}/roles")
        ));
        assert!(is_exit(&Method::POST, "/api/v1/auth/logout"));
        assert!(is_exit(&Method::POST, "/api/v1/auth/logout/all"));
        assert!(!is_exit(&Method::POST, "/api/v1/auth/login"));
    }

    #[test]
    fn a_page_polling_does_not_count_as_somebody_acting() {
        assert!(is_background("/api/v1/realtime/ws"));
        assert!(is_background("/api/v1/spaces/x/presence"));
        assert!(!is_background("/api/v1/me/spaces"));
    }
}
