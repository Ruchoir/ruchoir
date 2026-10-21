//! The app's presence on the desktop: tray, badge, closing to the tray, launch at login (filled in
//! by the shell step).

use tauri::{AppHandle, Runtime};

/// Show the total of unread notifications on the app's icon.
pub fn update_badge<R: Runtime>(_app: &AppHandle<R>) {}
