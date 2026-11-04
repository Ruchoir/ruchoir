//! The real-time hub: local connection registry plus the Valkey pub/sub bridge.
//!
//! # How a push reaches a client
//!
//! 1. A handler builds a [`RealtimeEnvelope`] and calls [`Hub::publish`] with the `audience`
//!    (user ids allowed to receive it, computed from membership at publish time).
//! 2. `publish` serializes a [`FanoutMessage`] and `PUBLISH`es it to the single `rt:fanout` Valkey
//!    channel via the command pool.
//! 3. Every API instance runs one [`SubscriberClient`] subscribed to `rt:fanout`. On each message
//!    its background task calls [`Hub::dispatch_local`], which delivers the inner envelope to every
//!    locally-connected sender whose user is in the audience.
//!
//! Going through Valkey even for the local instance keeps a single code path and makes the design
//! horizontally scalable: add API processes and they all see every event, each delivering only to
//! the clients it holds. The subscriber never touches PostgreSQL. A future optimization (noted, not
//! built) is to shard `rt:fanout` per space to cut cross-instance chatter.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use fred::interfaces::{EventInterface, PubsubInterface};
use fred::prelude::{ClientLike, Error, Pool};
use tokio::sync::mpsc;
use uuid::Uuid;

use super::event::{FanoutMessage, RealtimeEnvelope};
use crate::config::Config;

/// The Valkey channel every instance publishes to and subscribes from.
const FANOUT_CHANNEL: &str = "rt:fanout";

/// A handle identifying one live connection within a user's connection set.
type ConnId = u64;

/// One connected client's outbound queue. Bounded: when a slow client fills it, the newest event is
/// dropped (the client resyncs over REST) rather than stalling the fan-out for everyone.
type Outbound = mpsc::Sender<RealtimeEnvelope>;

/// A live connection: its queue, and the session it was opened with (so one session's connections
/// can be closed without touching the person's others).
struct Conn {
    session_id: String,
    tx: Outbound,
}

/// Shared real-time state: the command pool used to publish, and the in-memory registry of
/// locally-connected clients keyed by user then connection id.
pub struct Hub {
    /// Command connection pool (used for `PUBLISH` and presence key writes).
    valkey: Pool,
    /// `user_id -> { connection_id -> outbound sender }`. Guarded by a plain mutex: held only for
    /// the microseconds it takes to insert, remove, or clone the senders for one audience.
    connections: Mutex<HashMap<Uuid, HashMap<ConnId, Conn>>>,
    /// Monotonic source of connection ids.
    next_conn_id: AtomicU64,
    /// Per-connection outbound buffer capacity.
    send_buffer: usize,
}

impl Hub {
    /// Build the hub and start the background subscriber.
    ///
    /// Opens a dedicated [`SubscriberClient`] (a separate connection from the command pool, as
    /// pub/sub requires), subscribes it to `rt:fanout`, and spawns the loop that dispatches
    /// incoming fan-out messages to local connections. Returns the shared hub handle.
    pub async fn start(config: &Config, valkey: Pool) -> Result<Arc<Self>, Error> {
        let hub = Arc::new(Self {
            valkey,
            connections: Mutex::new(HashMap::new()),
            next_conn_id: AtomicU64::new(1),
            send_buffer: config.realtime_send_buffer,
        });

        // Same reconnection policy and timeouts as the command pool: without them a Valkey restart
        // would end the fan-out for good, and `manage_subscriptions` would have nothing to resume.
        let subscriber = crate::cache::builder(&config.valkey_url)?.build_subscriber_client()?;
        subscriber.init().await?;
        // Re-subscribe automatically across reconnects.
        subscriber.manage_subscriptions();
        subscriber.subscribe(FANOUT_CHANNEL).await?;

        let mut rx = subscriber.message_rx();
        let dispatch_hub = Arc::clone(&hub);
        tokio::spawn(async move {
            // Keep the subscriber alive for as long as the loop runs.
            let _subscriber = subscriber;
            loop {
                match rx.recv().await {
                    Ok(message) => {
                        let Some(text) = message.value.as_bytes_str() else {
                            continue;
                        };
                        match serde_json::from_slice::<FanoutMessage>(text.as_bytes()) {
                            Ok(fanout) => dispatch_hub.dispatch_local(&fanout),
                            Err(error) => {
                                tracing::warn!(%error, "dropping malformed fan-out message");
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        // The receiver fell behind: missed events are skipped. Clients resync over
                        // REST, so keep going.
                        tracing::warn!(skipped, "real-time subscriber lagged");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        // The broadcast channel closed (shutdown): stop the loop.
                        break;
                    }
                }
            }
        });

        Ok(hub)
    }

    /// Access the command pool (for presence heartbeats and snapshots).
    pub fn valkey(&self) -> &Pool {
        &self.valkey
    }

    /// Register a new connection for a user and return its id plus the receiving end of its queue.
    pub fn register(
        &self,
        user_id: Uuid,
        session_id: &str,
    ) -> (ConnId, mpsc::Receiver<RealtimeEnvelope>) {
        let conn_id = self.next_conn_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(self.send_buffer);
        let mut guard = self.connections.lock().expect("hub registry poisoned");
        guard.entry(user_id).or_default().insert(
            conn_id,
            Conn {
                session_id: session_id.to_owned(),
                tx,
            },
        );
        (conn_id, rx)
    }

    /// Remove a connection. Returns `true` if the user has no remaining local connections, which the
    /// caller uses to decide whether to clear the user's live-presence heartbeat.
    pub fn unregister(&self, user_id: Uuid, conn_id: ConnId) -> bool {
        let mut guard = self.connections.lock().expect("hub registry poisoned");
        match guard.get_mut(&user_id) {
            Some(conns) => {
                conns.remove(&conn_id);
                if conns.is_empty() {
                    guard.remove(&user_id);
                    return true;
                }
                false
            }
            // Already gone (its session was closed): nothing is left of the user here either.
            None => true,
        }
    }

    /// Close every connection a session opened, on this instance: dropping a queue's sender ends
    /// its socket or stream, which then deregisters itself. The person's other sessions keep theirs.
    pub fn close_session(&self, session_id: &str) {
        let mut guard = self.connections.lock().expect("hub registry poisoned");
        guard.retain(|_, conns| {
            conns.retain(|_, conn| conn.session_id != session_id);
            !conns.is_empty()
        });
    }

    /// Whether the user currently has at least one connection on THIS instance.
    pub fn is_locally_connected(&self, user_id: Uuid) -> bool {
        let guard = self.connections.lock().expect("hub registry poisoned");
        guard.get(&user_id).is_some_and(|c| !c.is_empty())
    }

    /// Publish an envelope to every connection (on any instance) owned by a user in `audience`.
    pub async fn publish(&self, audience: Vec<Uuid>, envelope: RealtimeEnvelope) {
        if audience.is_empty() {
            return;
        }
        let message = FanoutMessage { audience, envelope };
        let payload = match serde_json::to_string(&message) {
            Ok(json) => json,
            Err(error) => {
                tracing::error!(%error, "failed to serialize fan-out message");
                return;
            }
        };
        // `Pool` does not expose the pub/sub interface directly (PUBLISH still works on any
        // connection), so publish through one of its clients.
        if let Err(error) = self
            .valkey
            .next()
            .publish::<(), _, _>(FANOUT_CHANNEL, payload)
            .await
        {
            tracing::warn!(%error, "failed to publish real-time event");
        }
    }

    /// Deliver a fan-out message to matching local connections. Non-blocking: an event for a client
    /// whose buffer is full is dropped for that client only (it will resync over REST).
    fn dispatch_local(&self, message: &FanoutMessage) {
        let guard = self.connections.lock().expect("hub registry poisoned");
        for user_id in &message.audience {
            let Some(conns) = guard.get(user_id) else {
                continue;
            };
            for conn in conns.values() {
                if let Err(mpsc::error::TrySendError::Full(_)) =
                    conn.tx.try_send(message.envelope.clone())
                {
                    tracing::debug!(%user_id, "real-time buffer full; dropping event for one client");
                }
            }
        }
    }
}
