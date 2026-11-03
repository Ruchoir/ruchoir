//! File windows. The viewer's "open in a new tab" has no tab to open in here, so the interface asks
//! for a window of its own: a decorated one showing a file's bytes (its preview, or the converted
//! document) on the app's protocol, which the webview renders as a browser tab would (a PDF, an
//! image). Only those two paths are accepted. The window shows a file and no interface, and holds
//! no capability, so no command can be called from it. What keeps a script in an SVG or HTML file
//! from running there is the response's policy (the instance's own, or `INLINE_FILE_CSP` added by
//! the core's proxy), not this window. It follows the main window's rules for navigation, new
//! windows and downloads.

use ruchoir_desktop_core::files::{is_file_bytes_path, own_path, window_label, window_title};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Open the app's own `href` in a window, or bring forward the one already showing it.
#[tauri::command]
pub async fn file_window<R: Runtime>(
    app: AppHandle<R>,
    href: String,
    title: String,
) -> Result<(), String> {
    let path = own_path(&href, crate::APP_SCHEME).ok_or("refused")?;
    // Only a file's bytes: nothing else of the API belongs in a window of its own.
    if !is_file_bytes_path(&path) {
        return Err("refused".into());
    }
    let label = window_label(&path);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.unminimize();
        return window.set_focus().map_err(|_| "failed".to_owned());
    }
    let base = crate::app_url();
    let url = base.join(&path).map_err(|_| "refused")?;
    // Belt and braces after `own_path`: the joined address must still be the app's own origin.
    if url.scheme() != base.scheme()
        || url.host_str() != base.host_str()
        || url.port() != base.port()
    {
        return Err("refused".into());
    }
    // An async command, so the build runs off the main thread (a synchronous one can deadlock on Windows).
    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::CustomProtocol(url))
        .title(window_title(&title))
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
        .build();
    match built {
        Ok(_) => Ok(()),
        // A second call for the same address won the race: show that window.
        Err(_) => match app.get_webview_window(&label) {
            Some(window) => {
                let _ = window.show();
                let _ = window.unminimize();
                window.set_focus().map_err(|_| "failed".to_owned())
            }
            None => Err("failed".to_owned()),
        },
    }
}
