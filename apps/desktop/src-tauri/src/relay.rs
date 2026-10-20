//! The watchers of the signed-in instances, and the relay of their frames to the interface.
//!
//! Events `socket:open`, `socket:message` and `socket:closed` carry `{ instance, frame? }`, so the
//! interface's socket for an instance listens to its own frames only. While the window is minimised
//! the relay pauses: the interface is told its sockets closed and stops redrawing, the watchers stay
//! connected, and on return the interface is told they opened, which makes it catch up once.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use ruchoir_desktop_core::watcher::{frame_allowed, Watcher, WatcherEvent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::state::{changed, Desktop};

/// The running watchers, by instance id.
#[derive(Default)]
pub struct Relay {
    watchers: Mutex<HashMap<String, Watcher>>,
    paused: AtomicBool,
}

#[derive(Clone, Serialize)]
struct SocketEvent {
    instance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    frame: Option<String>,
}

/// Start a watcher for every signed-in instance that has none, and stop those whose instance is
/// gone or signed out.
pub fn reconcile<R: Runtime>(app: &AppHandle<R>) {
    // Called from `setup` and from synchronous commands too: watchers are tasks of the app's runtime.
    let runtime = tauri::async_runtime::handle();
    let _entered = runtime.inner().enter();
    let desktop = app.state::<Desktop>();
    let relay = app.state::<Relay>();
    let wanted: Vec<(String, String, String)> = desktop
        .list
        .lock()
        .map(|list| {
            list.instances
                .iter()
                .filter_map(|i| {
                    let token = desktop.vault.get(&i.id)?;
                    Some((i.id.clone(), i.origin.clone(), token))
                })
                .collect()
        })
        .unwrap_or_default();
    let Ok(mut watchers) = relay.watchers.lock() else {
        return;
    };
    let keep: Vec<&String> = wanted.iter().map(|(id, _, _)| id).collect();
    let gone: Vec<String> = watchers
        .keys()
        .filter(|id| !keep.contains(id))
        .cloned()
        .collect();
    for id in gone {
        if let Some(watcher) = watchers.remove(&id) {
            watcher.stop();
        }
    }
    for (id, origin, token) in wanted {
        if watchers.contains_key(&id) {
            continue;
        }
        let handle = app.clone();
        let instance = id.clone();
        let watcher = Watcher::spawn(origin, token, move |event| {
            on_event(&handle, &instance, event);
        });
        watchers.insert(id, watcher);
    }
}

fn on_event<R: Runtime>(app: &AppHandle<R>, instance: &str, event: WatcherEvent) {
    let relay = app.state::<Relay>();
    let paused = relay.paused.load(Ordering::Relaxed);
    let payload = |frame| SocketEvent {
        instance: instance.to_string(),
        frame,
    };
    match event {
        WatcherEvent::Open if !paused => {
            let _ = app.emit("socket:open", payload(None));
        }
        WatcherEvent::Message(frame) if !paused => {
            let _ = app.emit("socket:message", payload(Some(frame)));
        }
        WatcherEvent::Closed if !paused => {
            let _ = app.emit("socket:closed", payload(None));
        }
        WatcherEvent::SignedOut => {
            app.state::<Desktop>().forget_session(instance);
            if let Ok(mut watchers) = relay.watchers.lock() {
                watchers.remove(instance);
            }
            let _ = app.emit("socket:closed", payload(None));
            changed(app);
        }
        _ => {}
    }
}

/// Pause or resume the relay (the window was minimised or brought back).
pub fn set_paused<R: Runtime>(app: &AppHandle<R>, paused: bool) {
    let relay = app.state::<Relay>();
    if relay.paused.swap(paused, Ordering::Relaxed) == paused {
        return;
    }
    let ids: Vec<String> = relay
        .watchers
        .lock()
        .map(|w| w.keys().cloned().collect())
        .unwrap_or_default();
    let name = if paused {
        "socket:closed"
    } else {
        "socket:open"
    };
    for instance in ids {
        let _ = app.emit(
            name,
            SocketEvent {
                instance,
                frame: None,
            },
        );
    }
}

/// A frame from the interface: typing or a ping, for one instance.
#[tauri::command]
pub fn socket_send(relay: State<'_, Relay>, instance: String, frame: String) {
    if !frame_allowed(&frame) {
        return;
    }
    if let Ok(watchers) = relay.watchers.lock() {
        if let Some(watcher) = watchers.get(&instance) {
            watcher.send(frame);
        }
    }
}
