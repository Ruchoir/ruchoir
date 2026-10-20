//! Ruchoir for Windows, macOS and Linux.
//!
//! The window loads the app's own protocol (`ruchoir-app://localhost/`, written
//! `http://ruchoir-app.localhost/` on Windows), which serves the embedded web interface and, from
//! later steps on, forwards each instance's API with its bearer (see `protocol.rs`). The logic that
//! needs no window lives in `ruchoir-desktop-core`.

// No console window behind the app on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod protocol;
mod relay;
mod state;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

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

/// Whether the window may follow a navigation; a link to another site is opened outside instead.
fn leave_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &tauri::Url) -> bool {
    use ruchoir_desktop_core::navigation::{navigation, Navigation};
    use tauri_plugin_opener::OpenerExt;
    match navigation(url) {
        Navigation::Stay => true,
        Navigation::OpenOutside => {
            let _ = app.opener().open_url(url.as_str(), None::<&str>);
            false
        }
        Navigation::Refuse => false,
    }
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
        .invoke_handler(tauri::generate_handler![
            state::instance_state,
            state::instance_add,
            state::sign_in_start,
            state::sign_in_cancel,
            relay::socket_send,
            relay::socket_is_open,
        ])
        .setup(|app| {
            let list_path = app.path().app_data_dir()?.join("instances.json");
            app.manage(state::Desktop::new(
                list_path,
                ruchoir_desktop_core::vault::open_vault(),
            ));
            app.manage(relay::Relay::default());
            relay::reconcile(app.handle());

            // `ruchoir://auth?code=...`, whether it launched the app or reached it running (the
            // single-instance plugin hands a second launch's link over to this same handler).
            // Registration needs `xdg-mime` and `update-desktop-database` on Linux, which a minimal
            // system may lack: the app still works without it (links then do not reach it).
            #[cfg(any(windows, target_os = "linux"))]
            if let Err(error) = app.deep_link().register_all() {
                eprintln!("ruchoir: the ruchoir:// links could not be registered: {error}");
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    tauri::async_runtime::spawn(state::handle_deep_link(
                        handle.clone(),
                        url.to_string(),
                    ));
                }
            });
            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    tauri::async_runtime::spawn(state::handle_deep_link(
                        app.handle().clone(),
                        url.to_string(),
                    ));
                }
            }

            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(app_url()))
                    .title("Ruchoir")
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(360.0, 560.0)
                    // The window shows Ruchoir only: other sites open in the system browser.
                    .on_navigation({
                        let handle = app.handle().clone();
                        move |url| leave_for(&handle, url)
                    })
                    .on_new_window({
                        let handle = app.handle().clone();
                        move |url, _| {
                            leave_for(&handle, &url);
                            tauri::webview::NewWindowResponse::Deny
                        }
                    });
            // Frameless with the interface's own title bar on Windows and Linux; on macOS the
            // system's traffic lights stay, drawn over the same bar.
            #[cfg(target_os = "macos")]
            let window = window
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            #[cfg(not(target_os = "macos"))]
            let window = window.decorations(false);
            let window = window.build()?;
            // A minimised window needs no live interface: pause the relay (spec, "Lightness").
            let handle = app.handle().clone();
            let watched = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Resized(_) = event {
                    relay::set_paused(&handle, watched.is_minimized().unwrap_or(false));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the app runs");
}
