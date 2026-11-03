//! File windows. The viewer's "open in a new tab" has no tab to open in here, so the interface asks
//! for a window of its own: a decorated one showing the file's address on the app's protocol, which
//! the webview renders as a browser tab would (a PDF, an image). It shows a file and no interface,
//! so it holds no capability and no command can be called from it. It follows the main window's
//! rules for navigation, new windows and downloads.

use ruchoir_desktop_core::files::{own_path, safe_name, window_label};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Open the app's own `href` in a window, or bring forward the one already showing it.
#[tauri::command]
pub async fn file_window<R: Runtime>(
    app: AppHandle<R>,
    href: String,
    title: String,
) -> Result<(), String> {
    let path = own_path(&href, crate::APP_SCHEME).ok_or("refused")?;
    let label = window_label(&path);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        return window.set_focus().map_err(|_| "failed".to_owned());
    }
    let url = crate::app_url().join(&path).map_err(|_| "refused")?;
    // An async command, so the build runs off the main thread (a synchronous one can deadlock on Windows).
    WebviewWindowBuilder::new(&app, label, WebviewUrl::CustomProtocol(url))
        .title(safe_name(&title))
        .inner_size(1000.0, 760.0)
        .decorations(true)
        .on_navigation({
            let handle = app.clone();
            move |url| crate::leave_for(&handle, url)
        })
        .on_new_window({
            let handle = app.clone();
            move |url, _| crate::deny_new_window(&handle, &url)
        })
        .on_download({
            let handle = app.clone();
            move |_, event| crate::route_download(&handle, event)
        })
        .build()
        .map(|_| ())
        .map_err(|_| "failed".to_owned())
}
