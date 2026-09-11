//! The WebSocket transport: one socket per client, carrying server-to-client pushes and the two
//! ephemeral client-to-server signals (typing and heartbeat/presence).
//!
//! Authentication happens on the upgrade request itself: the `AuthSession` extractor reads the
//! same-origin session cookie the browser sends with the handshake, so an unauthenticated client is
//! rejected before the socket opens. Once upgraded, the connection registers with the [`Hub`],
//! refreshes its presence heartbeat for as long as the client keeps answering, and relays queued
//! envelopes to the client. All mutations still go through REST: the socket never accepts a
//! message-write command.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::state::AppState;

use super::presence;
use super::typing;

/// `GET /api/v1/realtime/ws`: upgrade to a WebSocket for the authenticated caller.
#[utoipa::path(
    get,
    path = "/api/v1/realtime/ws",
    tag = "realtime",
    responses(
        (status = 101, description = "Switching protocols to WebSocket"),
        (status = 401, description = "Authentication required")
    )
)]
pub async fn ws_handler(
    State(state): State<AppState>,
    session: AuthSession,
    ws: WebSocketUpgrade,
) -> Response {
    let user_id = session.user_id;
    ws.on_upgrade(move |socket| handle_socket(state, user_id, socket))
}

/// A message a client may send over the socket. Everything else is a mutation and must use REST.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    /// The caller is typing in a conversation.
    Typing { conversation_id: Uuid },
    /// Keep-alive; also refreshes the presence heartbeat.
    Ping,
}

/// Drive one connection until the socket closes.
async fn handle_socket(state: AppState, user_id: Uuid, socket: WebSocket) {
    let (conn_id, mut rx) = state.hub.register(user_id);

    // Mark the user reachable immediately and announce presence to their space.
    presence::heartbeat(state.hub.valkey(), user_id, state.config.presence_ttl_secs).await;
    presence::refresh_and_broadcast(&state, user_id).await;

    let (mut sink, mut stream) = socket.split();
    let heartbeat_secs = state.config.presence_heartbeat_secs.max(1) as u64;
    // How long a socket may say nothing at all before we stop believing it. The client is pinged
    // once per heartbeat and a browser answers at the protocol level without any code of its own,
    // so silence for a whole presence window means the other end is gone.
    let silence_limit = (state.config.presence_ttl_secs.max(1) as u64).max(heartbeat_secs * 2);

    // Every frame the client sends, of any kind, timestamped as seconds since this socket opened.
    // Shared with the outbound task, which is the one that decides whether to keep the user online.
    let opened = Instant::now();
    let last_frame = Arc::new(AtomicU64::new(0));

    // Outbound: forward queued envelopes to the client, and keep the presence heartbeat alive for
    // as long as the client keeps proving it is there.
    //
    // It used to refresh on a timer alone, which made presence a statement about the server rather
    // than about the person: a socket half open after a laptop slept or a network dropped kept the
    // key warm for ever, and the user stayed green until something else closed it. A TTL nothing
    // can let lapse is not a TTL.
    let outbound_state = state.clone();
    let outbound_seen = Arc::clone(&last_frame);
    let mut outbound = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(heartbeat_secs));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                maybe_event = rx.recv() => {
                    let Some(event) = maybe_event else { break };
                    let json = match serde_json::to_string(&event) {
                        Ok(json) => json,
                        Err(error) => {
                            tracing::error!(%error, "failed to serialize outbound envelope");
                            continue;
                        }
                    };
                    if sink.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                _ = ticker.tick() => {
                    let quiet = opened
                        .elapsed()
                        .as_secs()
                        .saturating_sub(outbound_seen.load(Ordering::Relaxed));
                    if quiet >= silence_limit {
                        // Breaking here ends the connection, which clears the heartbeat and tells
                        // the space this user went offline. A half-open socket answers no ping and
                        // no close frame, so this is the only thing that will ever notice.
                        tracing::debug!(%user_id, quiet, "closing a socket that stopped answering");
                        break;
                    }
                    // A browser answers a protocol ping on its own, so this needs nothing of the
                    // client but that it still exists.
                    if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                    presence::heartbeat(
                        outbound_state.hub.valkey(),
                        user_id,
                        outbound_state.config.presence_ttl_secs,
                    )
                    .await;
                }
            }
        }
    });

    // Inbound: handle the small set of client signals until the socket closes.
    let inbound_state = state.clone();
    let inbound_seen = Arc::clone(&last_frame);
    let mut inbound = tokio::spawn(async move {
        while let Some(Ok(message)) = stream.next().await {
            // Any frame is evidence the other end is alive, a pong as much as a signal. This is
            // what the outbound heartbeat reads before deciding the user is still present.
            inbound_seen.store(opened.elapsed().as_secs(), Ordering::Relaxed);
            match message {
                Message::Text(text) => {
                    if let Ok(client_message) = serde_json::from_str::<ClientMessage>(text.as_str())
                    {
                        handle_client_message(&inbound_state, user_id, client_message).await;
                    }
                }
                Message::Close(_) => break,
                // Pong answers our ping and Ping is answered by the transport itself; both have
                // already counted as evidence above, and neither carries anything to act on.
                _ => {}
            }
        }
    });

    // When either half ends (client left or send failed), tear the other down.
    tokio::select! {
        _ = &mut outbound => inbound.abort(),
        _ = &mut inbound => outbound.abort(),
    }

    // Deregister; if this was the user's last connection on this instance, drop their heartbeat and
    // announce that they went offline.
    let was_last = state.hub.unregister(user_id, conn_id);
    if was_last && !state.hub.is_locally_connected(user_id) {
        presence::clear(state.hub.valkey(), user_id).await;
        presence::refresh_and_broadcast(&state, user_id).await;
    }
}

/// Act on one client signal.
async fn handle_client_message(state: &AppState, user_id: Uuid, message: ClientMessage) {
    match message {
        ClientMessage::Ping => {
            presence::heartbeat(state.hub.valkey(), user_id, state.config.presence_ttl_secs).await;
        }
        ClientMessage::Typing { conversation_id } => {
            typing::signal(state, user_id, conversation_id).await;
        }
    }
}
