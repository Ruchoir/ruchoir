//! One realtime socket per signed-in instance, held by the app rather than by the interface.
//!
//! It is what keeps an instance live when its spaces are not on screen (notifications and counts,
//! from step 2), and for the instance on screen it is also the interface's socket: every frame is
//! relayed to the webview, tagged with its instance, so there is never a second socket. The socket
//! carries the bearer and no `Origin`, which the API accepts from a client that is not a browser.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

/// What a watcher tells the app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatcherEvent {
    /// The socket is open (again).
    Open,
    /// A frame from the instance, as the API sent it.
    Message(String),
    /// The socket dropped; the watcher is already trying again.
    Closed,
    /// The instance refused the session: the watcher has stopped for good.
    SignedOut,
}

/// The wait before reconnection attempt `attempt` (0 first): 1 s doubling up to 30 s, plus up to
/// 20 % of jitter so many apps waking at once do not knock together.
pub fn backoff(attempt: u32) -> Duration {
    let base_ms = 1000u64.saturating_mul(1u64 << attempt.min(5)).min(30_000);
    let mut byte = [0u8; 1];
    let _ = getrandom::fill(&mut byte);
    let jitter = base_ms * u64::from(byte[0]) / 255 / 5;
    Duration::from_millis(base_ms + jitter)
}

/// The frames the interface may send up the socket: typing and pings, nothing else (every mutation
/// goes through the API, and the socket accepts no other kind anyway).
pub fn frame_allowed(frame: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(frame)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
        .is_some_and(|kind| kind == "ping" || kind == "typing")
}

/// A running watcher. Dropping it does not stop it; `stop` does.
pub struct Watcher {
    outgoing: mpsc::UnboundedSender<String>,
    task: JoinHandle<()>,
}

impl Watcher {
    /// Connect to `origin`'s realtime socket with `token`, and keep connecting until stopped or
    /// signed out.
    pub fn spawn<F>(origin: String, token: String, sink: F) -> Watcher
    where
        F: Fn(WatcherEvent) + Send + Sync + 'static,
    {
        let (outgoing, mut frames) = mpsc::unbounded_channel::<String>();
        let url = format!(
            "{}/api/v1/realtime/ws",
            origin
                .replacen("https://", "wss://", 1)
                .replacen("http://", "ws://", 1)
        );
        let task = tokio::spawn(async move {
            let mut attempt = 0u32;
            loop {
                let Ok(mut request) = url.as_str().into_client_request() else {
                    return;
                };
                if let Ok(value) = format!("Bearer {token}").parse() {
                    request.headers_mut().insert("authorization", value);
                }
                match tokio_tungstenite::connect_async(request).await {
                    Ok((socket, _)) => {
                        attempt = 0;
                        sink(WatcherEvent::Open);
                        let (mut write, mut read) = socket.split();
                        loop {
                            tokio::select! {
                                incoming = read.next() => match incoming {
                                    Some(Ok(Message::Text(text))) => sink(WatcherEvent::Message(text.to_string())),
                                    // Pings are answered by the library as they are read.
                                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                                    Some(Ok(_)) => {}
                                },
                                frame = frames.recv() => match frame {
                                    Some(frame) => {
                                        if write.send(Message::Text(frame.into())).await.is_err() {
                                            break;
                                        }
                                    }
                                    None => return,
                                },
                            }
                        }
                        sink(WatcherEvent::Closed);
                    }
                    Err(WsError::Http(response)) if response.status().as_u16() == 401 => {
                        sink(WatcherEvent::SignedOut);
                        return;
                    }
                    Err(_) => {}
                }
                // Frames typed while the socket was down are dropped: they were ephemeral.
                while frames.try_recv().is_ok() {}
                tokio::time::sleep(backoff(attempt)).await;
                attempt = attempt.saturating_add(1);
            }
        });
        Watcher { outgoing, task }
    }

    /// Send a frame up the socket, if it is open.
    pub fn send(&self, frame: String) {
        let _ = self.outgoing.send(frame);
    }

    /// Close the socket and stop reconnecting.
    pub fn stop(self) {
        self.task.abort();
    }
}
