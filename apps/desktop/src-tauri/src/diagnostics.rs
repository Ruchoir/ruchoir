//! What the app knows about itself, for a person asking for help (spec, "Error handling": logs and
//! "Copy diagnostics"). The log is a file in the system's log folder for the app, rotated so it never
//! grows past a few megabytes; what the app writes there names what happened (a check that failed, a
//! notification not shown), never what a message says and never a session token. The diagnostics are
//! the app's version, the system, the web engine, how it was installed, how many instances it holds
//! and the end of the log: text the person reads, then pastes where they choose.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

use crate::state::Desktop;

/// The log's file name in the app's log folder (`ruchoir.log`, then rotated copies).
const LOG_NAME: &str = "ruchoir";
/// One file's size before it is rotated, and how many old ones are kept: 4 x 1 MB at most.
const LOG_BYTES: u128 = 1024 * 1024;
const LOG_KEPT: usize = 3;
/// How much of the log's end the diagnostics carry.
const TAIL_LINES: usize = 200;

/// The logger, at `info`: one line per thing worth knowing, none per message.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir {
            file_name: Some(LOG_NAME.into()),
        }))
        .target(Target::new(TargetKind::Stderr))
        .level(log::LevelFilter::Info)
        .max_file_size(LOG_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(LOG_KEPT))
        .build()
}

fn log_folder<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_log_dir().ok()
}

/// The last `lines` lines of `text`.
fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// How the app was installed, as the updater sees it.
pub(crate) fn bundle() -> &'static str {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    match bundle_type() {
        Some(BundleType::Nsis) => "nsis",
        Some(BundleType::Msi) => "msi",
        Some(BundleType::App) | Some(BundleType::Dmg) => "macos-app",
        Some(BundleType::AppImage) => "appimage",
        Some(BundleType::Deb) => "deb",
        Some(BundleType::Rpm) => "rpm",
        _ => "unknown",
    }
}

/// The app as "About" shows it.
#[derive(Debug, Serialize)]
pub struct About {
    pub version: String,
    pub os: String,
    pub arch: String,
    pub webview: String,
    pub bundle: String,
}

fn about<R: Runtime>(app: &AppHandle<R>) -> About {
    About {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        webview: tauri::webview_version().unwrap_or_else(|_| "unknown".to_owned()),
        bundle: bundle().to_owned(),
    }
}

/// The version, system and web engine, for the preferences' "About".
#[tauri::command]
pub fn about_app<R: Runtime>(app: AppHandle<R>) -> About {
    about(&app)
}

/// The text "Copy diagnostics" puts on the clipboard. Instances are counted and named by their host
/// only; nothing of a session, an account or a conversation is in it.
#[tauri::command]
pub async fn diagnostics<R: Runtime>(app: AppHandle<R>) -> String {
    let about = about(&app);
    let views = app.state::<Desktop>().views();
    let signed_in = views.iter().filter(|v| v.state == "signed_in").count();
    let hosts: Vec<String> = views
        .iter()
        .filter_map(|v| v.origin.as_deref())
        .map(|origin| origin.trim_start_matches("https://").to_owned())
        .collect();
    let log = match log_folder(&app).map(|dir| dir.join(format!("{LOG_NAME}.log"))) {
        Some(path) => tokio::fs::read_to_string(&path)
            .await
            .map(|text| tail(&text, TAIL_LINES))
            .unwrap_or_else(|_| "(no log yet)".to_owned()),
        None => "(no log folder)".to_owned(),
    };
    format!(
        "Ruchoir desktop {}\nSystem: {} {}\nWeb engine: {}\nInstalled as: {}\nInstances: {} ({} signed in): {}\n\nLog (last {} lines):\n{}\n",
        about.version,
        about.os,
        about.arch,
        about.webview,
        about.bundle,
        views.len(),
        signed_in,
        hosts.join(", "),
        TAIL_LINES,
        log,
    )
}

/// Open the folder holding the log, for someone asked to send the files themselves.
#[tauri::command]
pub fn open_log_folder<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let folder = log_folder(&app).ok_or("no_folder")?;
    std::fs::create_dir_all(&folder).map_err(|_| "no_folder")?;
    app.opener()
        .open_path(folder.to_string_lossy(), None::<&str>)
        .map_err(|_| "no_app".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tail_keeps_the_last_lines() {
        assert_eq!(tail("a\nb\nc\nd", 2), "c\nd");
        assert_eq!(tail("a\nb", 5), "a\nb");
        assert_eq!(tail("", 3), "");
    }
}
