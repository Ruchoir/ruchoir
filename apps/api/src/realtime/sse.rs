//! The Server-Sent Events fallback transport.
//!
//! Where a WebSocket is blocked (some corporate proxies), a client falls back to SSE: a one-way,
//! read-only stream of the same [`RealtimeEnvelope`] frames. Because SSE cannot carry client-to-
//! server frames, typing on this transport is a separate `POST /realtime/typing`, and presence is
//! kept alive by a server-side timer for the life of the stream rather than by client pings.
//!
//! Cleanup is tied to the stream's lifetime: a guard captured by the response runs on drop when the
//! HTTP connection ends, deregistering the connection and, if it was the user's last, clearing their
//! presence heartbeat.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures_util::StreamExt;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::messaging::dto::TypingRequest;
use crate::state::AppState;

use super::event::RealtimeEnvelope;
use super::{presence, typing};

/// Runs connection cleanup when the SSE response is dropped (the client disconnected).
struct ConnGuard {
    state: AppState,
    user_id: Uuid,
    conn_id: u64,
    heartbeat: JoinHandle<()>,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.heartbeat.abort();
        let state = self.state.clone();
        let user_id = self.user_id;
        let conn_id = self.conn_id;
        // Drop cannot be async: hand the teardown to a task.
        tokio::spawn(async move {
            let was_last = state.hub.unregister(user_id, conn_id);
            if was_last && !state.hub.is_locally_connected(user_id) {
                presence::clear(state.hub.valkey(), user_id).await;
                presence::refresh_and_broadcast(&state, user_id).await;
            }
        });
    }
}

/// `GET /api/v1/realtime/sse`: subscribe to the caller's real-time event stream.
#[utoipa::path(
    get,
    path = "/api/v1/realtime/sse",
    tag = "realtime",
    responses(
        (status = 200, description = "Server-sent event stream of real-time envelopes"),
        (status = 401, description = "Authentication required")
    )
)]
pub async fn sse_handler(
    State(state): State<AppState>,
    session: AuthSession,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let user_id = session.user_id;
    let (conn_id, rx) = state.hub.register(user_id, &session.session_id);

    presence::heartbeat(state.hub.valkey(), user_id, state.config.presence_ttl_secs).await;
    presence::refresh_and_broadcast(&state, user_id).await;

    // Refresh presence on a timer for as long as the stream is open.
    let hb_state = state.clone();
    let heartbeat_secs = state.config.presence_heartbeat_secs.max(1) as u64;
    let heartbeat = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(heartbeat_secs));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            presence::heartbeat(
                hb_state.hub.valkey(),
                user_id,
                hb_state.config.presence_ttl_secs,
            )
            .await;
        }
    });

    let guard = ConnGuard {
        state: state.clone(),
        user_id,
        conn_id,
        heartbeat,
    };

    let stream = ReceiverStream::new(rx).map(move |envelope| {
        // Capture the guard so its `Drop` (cleanup) fires when the client disconnects.
        let _keep_alive = &guard;
        Ok(to_event(&envelope))
    });

    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(heartbeat_secs)))
}

/// `POST /api/v1/realtime/typing`: typing signal for SSE-fallback clients (WS clients send it
/// inline). Best-effort: always `202`, since authorization and throttling are handled internally.
#[utoipa::path(
    post,
    path = "/api/v1/realtime/typing",
    tag = "realtime",
    request_body = TypingRequest,
    responses((status = 202, description = "Typing signal accepted for processing"))
)]
pub async fn typing_handler(
    State(state): State<AppState>,
    session: AuthSession,
    Json(body): Json<TypingRequest>,
) -> StatusCode {
    typing::signal(&state, session.user_id, body.conversation_id).await;
    StatusCode::ACCEPTED
}

/// Render an envelope as a named SSE event, falling back to a comment if serialization fails.
fn to_event(envelope: &RealtimeEnvelope) -> Event {
    match Event::default()
        .event(envelope.event_type.clone())
        .json_data(envelope)
    {
        Ok(event) => event,
        Err(error) => {
            tracing::error!(%error, "failed to encode SSE event");
            Event::default().comment("encode error")
        }
    }
}
