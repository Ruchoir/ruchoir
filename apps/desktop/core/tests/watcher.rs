//! The watcher against a stand-in realtime endpoint.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use ruchoir_desktop_core::watcher::{backoff, frame_allowed, Watcher, WatcherEvent};

#[test]
fn backoff_caps_at_30s() {
    assert!(backoff(0) >= Duration::from_secs(1));
    assert!(backoff(0) <= Duration::from_millis(1200));
    assert!(backoff(3) >= Duration::from_secs(8));
    assert!(backoff(10) <= Duration::from_secs(36));
    assert!(backoff(40) <= Duration::from_secs(36));
}

#[test]
fn socket_send_filters_frame_types() {
    assert!(frame_allowed(r#"{"type":"ping"}"#));
    assert!(frame_allowed(r#"{"type":"typing","conversation_id":"c1"}"#));
    assert!(!frame_allowed(r#"{"type":"message"}"#));
    assert!(!frame_allowed("not json"));
    assert!(!frame_allowed(r#"{"kind":"ping"}"#));
}

/// A realtime endpoint: refuses without the right bearer, sends one frame, then closes (so the
/// watcher has to come back), counting connections.
async fn stand_in(token: &'static str) -> (String, Arc<AtomicUsize>, Arc<Mutex<Vec<String>>>) {
    let connections = Arc::new(AtomicUsize::new(0));
    let received = Arc::new(Mutex::new(Vec::new()));
    let (c, r) = (connections.clone(), received.clone());
    let app = Router::new().route(
        "/api/v1/realtime/ws",
        get(move |headers: HeaderMap, ws: WebSocketUpgrade| {
            let (c, r) = (c.clone(), r.clone());
            async move {
                let bearer = headers.get("authorization").and_then(|v| v.to_str().ok());
                if bearer != Some(&format!("Bearer {token}")) || headers.contains_key("origin") {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                c.fetch_add(1, Ordering::SeqCst);
                ws.on_upgrade(move |mut socket| async move {
                    let _ = socket.send(Message::Text(r#"{"type":"x"}"#.into())).await;
                    if let Ok(Some(Ok(Message::Text(text)))) =
                        tokio::time::timeout(Duration::from_millis(300), socket.recv()).await
                    {
                        r.lock().unwrap().push(text.to_string());
                    }
                    let _ = socket.send(Message::Close(None)).await;
                })
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), connections, received)
}

fn collect() -> (
    Arc<Mutex<Vec<WatcherEvent>>>,
    impl Fn(WatcherEvent) + Send + Sync + 'static,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let e = events.clone();
    (events, move |event| e.lock().unwrap().push(event))
}

#[tokio::test]
async fn relays_frames_and_sends_bearer() {
    let (origin, _, received) = stand_in("t").await;
    let (events, sink) = collect();
    let watcher = Watcher::spawn(origin, "t".into(), sink);
    tokio::time::sleep(Duration::from_millis(100)).await;
    watcher.send(r#"{"type":"ping"}"#.into());
    tokio::time::sleep(Duration::from_millis(400)).await;
    let seen = events.lock().unwrap().clone();
    assert_eq!(seen[0], WatcherEvent::Open);
    assert_eq!(seen[1], WatcherEvent::Message(r#"{"type":"x"}"#.into()));
    assert_eq!(received.lock().unwrap().as_slice(), [r#"{"type":"ping"}"#]);
    watcher.stop();
}

#[tokio::test]
async fn reconnects_after_server_drop() {
    let (origin, connections, _) = stand_in("t").await;
    let (events, sink) = collect();
    let watcher = Watcher::spawn(origin, "t".into(), sink);
    tokio::time::sleep(Duration::from_millis(2000)).await;
    assert!(connections.load(Ordering::SeqCst) >= 2);
    assert!(events.lock().unwrap().contains(&WatcherEvent::Closed));
    watcher.stop();
}

#[tokio::test]
async fn handshake_401_reports_signed_out_and_stops() {
    let (origin, connections, _) = stand_in("right").await;
    let (events, sink) = collect();
    let _watcher = Watcher::spawn(origin, "wrong".into(), sink);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(events.lock().unwrap().as_slice(), [WatcherEvent::SignedOut]);
    assert_eq!(connections.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn reports_whether_it_is_open() {
    let (origin, _, _) = stand_in("t").await;
    let (_, sink) = collect();
    let watcher = Watcher::spawn(origin, "t".into(), sink);
    assert!(!watcher.is_open());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(watcher.is_open());
    // The stand-in closes after 300 ms; the watcher is then between two attempts.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!watcher.is_open());
    watcher.stop();
}
