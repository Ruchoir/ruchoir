//! The app's presence on the desktop: the tray icon and its menu, the badge with the unread
//! notifications of every instance, closing to the tray, and launch at login.
//!
//! - Closing the window hides it (Windows and Linux: when "keep in the tray" is on, the default; macOS:
//!   always, as a Mac app stays in the dock). The first time, a notification says where it went.
//! - The relay to the interface pauses while the window is hidden, as while it is minimised.
//! - Started with `--hidden` (launch at login does), no window shows until the tray is clicked.
//! - The tray menu's words come from the interface's language (`set_shell_labels`); English before.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;

/// Where the desktop settings are kept.
const SETTINGS_STORE: &str = "desktop.json";

/// The argument launch at login passes, to start in the tray.
pub const HIDDEN_ARG: &str = "--hidden";

const TRAY_ID: &str = "main";

/// The app's own settings, edited in the interface's "Application" preferences.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopSettings {
    pub launch_at_login: bool,
    /// Windows and Linux; always true on macOS, where the switch is not shown.
    pub close_to_tray: bool,
    pub close_notice_seen: bool,
}

/// The words the core shows, in the interface's language.
#[derive(Debug, Clone, Deserialize)]
pub struct ShellLabels {
    pub open: String,
    pub quit: String,
    pub closed_to_tray: String,
}

impl Default for ShellLabels {
    fn default() -> Self {
        Self {
            open: "Open Ruchoir".into(),
            quit: "Quit".into(),
            closed_to_tray: "Ruchoir is still running in the tray.".into(),
        }
    }
}

/// The shell's state.
#[derive(Default)]
pub struct Shell {
    labels: Mutex<ShellLabels>,
}

fn read_settings<R: Runtime>(app: &AppHandle<R>) -> DesktopSettings {
    let stored = app
        .store(SETTINGS_STORE)
        .ok()
        .and_then(|s| s.get("settings"))
        .and_then(|v| serde_json::from_value::<DesktopSettings>(v).ok());
    let launch_at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let mut settings = stored.unwrap_or(DesktopSettings {
        launch_at_login,
        close_to_tray: true,
        close_notice_seen: false,
    });
    settings.launch_at_login = launch_at_login;
    if cfg!(target_os = "macos") {
        settings.close_to_tray = true;
    }
    settings
}

fn write_settings<R: Runtime>(app: &AppHandle<R>, settings: &DesktopSettings) {
    if let Ok(store) = app.store(SETTINGS_STORE) {
        if let Ok(value) = serde_json::to_value(settings) {
            store.set("settings", value);
            let _ = store.save();
        }
    }
}

#[tauri::command]
pub fn desktop_settings<R: Runtime>(app: AppHandle<R>) -> DesktopSettings {
    read_settings(&app)
}

#[tauri::command]
pub fn set_desktop_settings<R: Runtime>(
    app: AppHandle<R>,
    settings: DesktopSettings,
) -> Result<DesktopSettings, String> {
    let autolaunch = app.autolaunch();
    let result = if settings.launch_at_login {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    result.map_err(|_| "autostart".to_string())?;
    write_settings(&app, &settings);
    Ok(read_settings(&app))
}

/// The interface's words for the tray menu and the first-close notice.
#[tauri::command]
pub fn set_shell_labels<R: Runtime>(
    app: AppHandle<R>,
    shell: State<'_, Shell>,
    labels: ShellLabels,
) {
    if let Ok(mut current) = shell.labels.lock() {
        *current = labels.clone();
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = tray_menu(&app, &labels) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn tray_menu<R: Runtime>(app: &AppHandle<R>, labels: &ShellLabels) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open", &labels.open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>)?;
    Menu::with_items(app, &[&open, &quit])
}

/// Paint a red dot of radius `r` centred on (`cx`, `cy`) into an RGBA buffer `w` pixels wide.
fn paint_dot(rgba: &mut [u8], w: u32, h: u32, (cx, cy, r): (f32, f32, f32)) {
    for y in 0..h {
        for x in 0..w {
            let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
            if dx * dx + dy * dy <= r * r {
                let i = ((y * w + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(&[0xd9, 0x3b, 0x2b, 0xff]);
            }
        }
    }
}

/// The app's icon, and the same with a dot in its top right corner.
fn tray_images() -> (Image<'static>, Image<'static>) {
    let plain = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .expect("the bundled tray icon")
        .to_owned();
    let (w, h) = (plain.width(), plain.height());
    let mut rgba = plain.rgba().to_vec();
    paint_dot(
        &mut rgba,
        w,
        h,
        (w as f32 * 0.75, h as f32 * 0.25, w as f32 * 0.22),
    );
    (plain, Image::new_owned(rgba, w, h))
}

/// A plain dot, for Windows' taskbar overlay.
#[cfg(windows)]
fn overlay_dot() -> Image<'static> {
    let size = 16u32;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let c = size as f32 / 2.0;
    paint_dot(&mut rgba, size, size, (c, c, c - 1.0));
    Image::new_owned(rgba, size, size)
}

/// Create the tray icon and listen to it.
pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = tray_menu(app, &ShellLabels::default())?;
    let (plain, _) = tray_images();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(plain)
        .tooltip("Ruchoir")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Show the total of unread notifications on the app's icon and in the tray.
pub fn update_badge<R: Runtime>(app: &AppHandle<R>) {
    let total = crate::summaries::total_unread(app);
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        let _ = window.set_badge_label((total > 0).then(|| total.to_string()));
        #[cfg(windows)]
        let _ = window.set_overlay_icon((total > 0).then(overlay_dot));
        #[cfg(all(unix, not(target_os = "macos")))]
        let _ = window.set_badge_count((total > 0).then_some(i64::from(total)));
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let (plain, dot) = tray_images();
        let _ = tray.set_icon(Some(if total > 0 { dot } else { plain }));
        let _ = tray.set_tooltip(Some(if total > 0 {
            format!("Ruchoir ({total})")
        } else {
            "Ruchoir".to_string()
        }));
    }
}

/// Bring the window forward (from the tray, minimised or behind others).
pub fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    crate::relay::set_paused(app, false);
}

/// What the close button does: hide the window to the tray when the settings say so.
pub fn on_window_event<R: Runtime>(app: &AppHandle<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let mut settings = read_settings(app);
    if !settings.close_to_tray {
        return;
    }
    api.prevent_close();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    crate::relay::set_paused(app, true);
    if !settings.close_notice_seen && !cfg!(target_os = "macos") {
        let text = app
            .state::<Shell>()
            .labels
            .lock()
            .map(|l| l.closed_to_tray.clone())
            .unwrap_or_default();
        let _ = app
            .notification()
            .builder()
            .title("Ruchoir")
            .body(text)
            .show();
        settings.close_notice_seen = true;
        write_settings(app, &settings);
    }
}
