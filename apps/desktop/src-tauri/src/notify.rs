//! Native notifications from every instance.
//!
//! On a realtime `notification.created`, the core asks that instance's `GET /push/pending` for what
//! is new since the last one drawn and draws it with the system's notifications, unless that
//! instance's own settings say not to (off, quiet hours) or it is the instance on screen in a focused
//! window, where the interface shows it itself. A click opens the instance at the item's place and
//! brings the window forward (`desktop:open`, `{ instance, path }`).
//!
//! `since` is kept per instance across restarts (`notify-since.json`), and starts when the instance's
//! socket first opens, so a backlog is never drawn.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ruchoir_desktop_core::notifier::{
    advance, fetch_pending, fetch_settings, fresh, should_draw, target_path, NotifySettings,
};
use ruchoir_desktop_core::summary::FetchError;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;

use crate::state::{changed, Desktop};

/// Where `since` is kept.
const SINCE_STORE: &str = "notify-since.json";

/// How long an instance's settings are trusted before they are read again.
const SETTINGS_FOR: Duration = Duration::from_secs(30 * 60);

/// How many clicked-notification targets are remembered.
const KEEP_TARGETS: usize = 200;

/// The notifier's state.
#[derive(Default)]
pub struct Notifier {
    settings: Mutex<HashMap<String, (Instant, NotifySettings)>>,
    targets: Mutex<Vec<(i32, String, String)>>,
    busy: Mutex<HashSet<String>>,
    next_id: AtomicI32,
}

#[derive(Clone, Serialize)]
struct OpenEvent {
    instance: String,
    path: String,
}

/// The sound each system's notification server knows as its usual one.
fn system_sound() -> &'static str {
    if cfg!(target_os = "macos") {
        "default"
    } else if cfg!(windows) {
        "Default"
    } else {
        "message-new-instant"
    }
}

fn read_since<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<String> {
    let store = app.store(SINCE_STORE).ok()?;
    store.get(id)?.as_str().map(str::to_string)
}

fn write_since<R: Runtime>(app: &AppHandle<R>, id: &str, since: &str) {
    if let Ok(store) = app.store(SINCE_STORE) {
        store.set(id, since);
        let _ = store.save();
    }
}

/// The local minute of the day, UTC when the system's offset cannot be read.
fn minute_of_day() -> u32 {
    let now = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    u32::from(now.hour()) * 60 + u32::from(now.minute())
}

/// Whether `id` is the instance on screen in a focused, visible window.
fn on_screen<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    let open = app.state::<Desktop>().view().id;
    if open.as_deref() != Some(id) {
        return false;
    }
    app.get_webview_window("main").is_some_and(|w| {
        w.is_visible().unwrap_or(false)
            && w.is_focused().unwrap_or(false)
            && !w.is_minimized().unwrap_or(false)
    })
}

/// An instance's socket opened: start its `since` now if it has none, so no backlog is drawn.
pub fn on_open<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if read_since(app, id).is_none() {
        let now = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        write_since(app, id, &now);
    }
}

/// A realtime event of `kind` arrived for `instance`.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, instance: &str, kind: &str) {
    if kind != "notification.created" {
        return;
    }
    // One round at a time per instance; a later event's items are in the next `since` window anyway.
    let first = app
        .state::<Notifier>()
        .busy
        .lock()
        .map(|mut b| b.insert(instance.to_string()))
        .unwrap_or(false);
    if !first {
        return;
    }
    let app = app.clone();
    let id = instance.to_string();
    tauri::async_runtime::spawn(async move {
        draw(&app, &id).await;
        if let Ok(mut b) = app.state::<Notifier>().busy.lock() {
            b.remove(&id);
        }
    });
}

async fn settings<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    origin: &str,
    token: &str,
) -> Result<NotifySettings, FetchError> {
    let notifier = app.state::<Notifier>();
    if let Some((at, s)) = notifier
        .settings
        .lock()
        .ok()
        .and_then(|m| m.get(id).cloned())
    {
        if at.elapsed() < SETTINGS_FOR {
            return Ok(s);
        }
    }
    let desktop = app.state::<Desktop>();
    let fetched = fetch_settings(&desktop.http, origin, token).await?;
    if let Ok(mut m) = notifier.settings.lock() {
        m.insert(id.to_string(), (Instant::now(), fetched.clone()));
    }
    Ok(fetched)
}

async fn draw<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let desktop = app.state::<Desktop>();
    let Some((origin, Some(token))) = desktop.credentials(id) else {
        return;
    };
    let settings = match settings(app, id, &origin, &token).await {
        Ok(s) => s,
        Err(FetchError::Unauthorized) => return signed_out(app, id),
        Err(FetchError::Unreachable) => return,
    };
    let since = read_since(app, id);
    let pending = match fetch_pending(&desktop.http, &origin, &token, since.as_deref()).await {
        Ok(p) => p,
        Err(FetchError::Unauthorized) => return signed_out(app, id),
        Err(FetchError::Unreachable) => return,
    };
    let items = fresh(&pending.items, since.as_deref());
    if items.is_empty() {
        return;
    }
    // Whatever is decided, these are seen: never drawn later, out of their moment.
    if let Some(next) = advance(since.as_deref(), &items) {
        write_since(app, id, &next);
    }
    if !should_draw(&settings, minute_of_day(), on_screen(app, id)) {
        return;
    }
    let spaces = crate::summaries::get(app, id)
        .map(|s| s.spaces)
        .unwrap_or_default();
    let notifier = app.state::<Notifier>();
    for item in items {
        let nid = notifier.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let path = target_path(&item, &spaces);
        if let Ok(mut targets) = notifier.targets.lock() {
            targets.push((nid, id.to_string(), path));
            let excess = targets.len().saturating_sub(KEEP_TARGETS);
            targets.drain(..excess);
        }
        let mut builder = app
            .notification()
            .builder()
            .id(nid)
            .title(&item.title)
            .body(&item.body);
        if settings.sound && !pending.silent {
            builder = builder.sound(system_sound());
        }
        if let Err(error) = builder.show() {
            eprintln!("ruchoir: a notification could not be shown: {error}");
        }
    }
}

fn signed_out<R: Runtime>(app: &AppHandle<R>, id: &str) {
    app.state::<Desktop>().forget_session(id);
    crate::summaries::forget(app, id);
    changed(app);
}

/// Listen for clicks on the app's notifications.
pub fn listen_for_clicks<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |action| {
        if action.action_id() != "tap" {
            return;
        }
        let Some(nid) = action.notification().map(|n| n.id()) else {
            return;
        };
        let target = handle
            .state::<Notifier>()
            .targets
            .lock()
            .ok()
            .and_then(|t| t.iter().find(|(id, _, _)| *id == nid).cloned());
        if let Some((_, instance, path)) = target {
            open_at(&handle, &instance, &path);
        }
    });
}

/// Open an instance at a path and bring the window forward.
pub fn open_at<R: Runtime>(app: &AppHandle<R>, instance: &str, path: &str) {
    let desktop = app.state::<Desktop>();
    if let Ok(mut list) = desktop.list.lock() {
        if list.open(instance) {
            let _ = list.save(&desktop.list_path);
        }
    }
    // The address first: the interface writes it, then remounts on the instance when told it opened.
    let _ = app.emit(
        "desktop:open",
        OpenEvent {
            instance: instance.to_string(),
            path: path.to_string(),
        },
    );
    changed(app);
    crate::shell::show_window(app);
}

/// The interface saved this instance's notification settings: read them again at the next round.
#[tauri::command]
pub fn preferences_changed(notifier: State<'_, Notifier>, id: String) {
    if let Ok(mut m) = notifier.settings.lock() {
        m.remove(&id);
    }
}
