//! The app's presence on the desktop: tray, badge, closing to the tray, launch at login (filled in
//! by the shell step).

use tauri::{AppHandle, Runtime};

/// Show the total of unread notifications on the app's icon.
pub fn update_badge<R: Runtime>(_app: &AppHandle<R>) {}

/// Bring the window forward (from the tray, minimised or behind others).
pub fn show_window<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
