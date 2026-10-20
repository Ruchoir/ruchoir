//! Ruchoir for Windows, macOS and Linux.
//!
//! The window loads the app's own protocol (`ruchoir-app://localhost/`, written
//! `http://ruchoir-app.localhost/` on Windows), which serves the embedded web interface and, from
//! later steps on, forwards each instance's API with its bearer (see `protocol.rs`). The logic that
//! needs no window lives in `ruchoir-desktop-core`.

// No console window behind the app on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod protocol;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// The scheme of the app's own origin.
pub const APP_SCHEME: &str = "ruchoir-app";

/// The address the window opens: the custom protocol as each system's webview spells it.
fn app_url() -> tauri::Url {
    let url = if cfg!(windows) {
        "http://ruchoir-app.localhost/"
    } else {
        "ruchoir-app://localhost/"
    };
    url.parse().expect("a constant URL")
}

fn main() {
    // A small runtime: the app mostly waits on a few sockets (spec, "Lightness budget").
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("the async runtime starts");
    tauri::async_runtime::set(runtime.handle().clone());

    let builder = tauri::Builder::default()
        // First, so a second launch is caught before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build());

    protocol::register(builder)
        .setup(|app| {
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(app_url()))
                    .title("Ruchoir")
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(360.0, 560.0);
            // Frameless with the interface's own title bar on Windows and Linux; on macOS the
            // system's traffic lights stay, drawn over the same bar.
            #[cfg(target_os = "macos")]
            let window = window
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            #[cfg(not(target_os = "macos"))]
            let window = window.decorations(false);
            window.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the app runs");
}
