//! Native notifications from every instance (filled in by the notifier step).

use tauri::{AppHandle, Runtime};

/// A realtime event of `kind` arrived for `instance`.
pub fn on_event<R: Runtime>(_app: &AppHandle<R>, _instance: &str, _kind: &str) {}
