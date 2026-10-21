//! Each signed-in instance's summary (spaces with their counts, unread notifications), kept by the
//! core for the rail and the badge, and refreshed after the realtime events that can change it: at
//! most once per two seconds per instance, with one trailing refresh for what came in between.
//!
//! The interface reads them with `summaries` and hears `summary:changed` (`{ instance, summary }`).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ruchoir_desktop_core::summary::{fetch_summary, wants_refresh, Debounce, FetchError, Summary};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::state::{changed, Desktop};

/// The summaries, and what paces their refreshes.
#[derive(Default)]
pub struct Summaries {
    by_instance: Mutex<HashMap<String, Summary>>,
    debounce: Mutex<HashMap<String, Debounce>>,
    trailing: Mutex<HashSet<String>>,
}

#[derive(Clone, Serialize)]
struct SummaryEvent {
    instance: String,
    summary: Summary,
}

/// Drop an instance's summary (removed, or signed out).
pub fn forget<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Ok(mut map) = app.state::<Summaries>().by_instance.lock() {
        map.remove(id);
    }
    crate::shell::update_badge(app);
}

/// A realtime event arrived for `id` (or its socket opened): refresh if it can change the summary.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str, event_type: Option<&str>) {
    if let Some(kind) = event_type {
        if !wants_refresh(kind) {
            return;
        }
    }
    let summaries = app.state::<Summaries>();
    let now_allowed = summaries
        .debounce
        .lock()
        .map(|mut d| d.entry(id.to_string()).or_default().hit(Instant::now()))
        .unwrap_or(true);
    if now_allowed {
        refresh(app.clone(), id.to_string());
        return;
    }
    // Within the window: one trailing refresh for everything that comes in until it runs.
    let first = summaries
        .trailing
        .lock()
        .map(|mut t| t.insert(id.to_string()))
        .unwrap_or(false);
    if first {
        let app = app.clone();
        let id = id.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if let Ok(mut t) = app.state::<Summaries>().trailing.lock() {
                t.remove(&id);
            }
            refresh(app, id);
        });
    }
}

/// Fetch an instance's summary now, in the background.
pub fn refresh<R: Runtime>(app: AppHandle<R>, id: String) {
    tauri::async_runtime::spawn(async move {
        let desktop = app.state::<Desktop>();
        let Some((origin, Some(token))) = desktop.credentials(&id) else {
            return;
        };
        match fetch_summary(&desktop.http, &origin, &token).await {
            Ok(summary) => {
                if let Ok(mut map) = app.state::<Summaries>().by_instance.lock() {
                    map.insert(id.clone(), summary.clone());
                }
                let _ = app.emit(
                    "summary:changed",
                    SummaryEvent {
                        instance: id,
                        summary,
                    },
                );
                crate::shell::update_badge(&app);
            }
            Err(FetchError::Unauthorized) => {
                desktop.forget_session(&id);
                forget(&app, &id);
                changed(&app);
            }
            // Kept as it was; the next event tries again.
            Err(FetchError::Unreachable) => {}
        }
    });
}

#[tauri::command]
pub fn summaries(summaries: State<'_, Summaries>) -> HashMap<String, Summary> {
    summaries
        .by_instance
        .lock()
        .map(|m| m.clone())
        .unwrap_or_default()
}
