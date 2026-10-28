//! Updates (spec, "Updates and distribution"). The app asks `https://ruchoir.com/desktop/latest.json`
//! at launch and every six hours; what it offers is signed with the updater's own key (minisign),
//! whose public half is in `tauri.conf.json`, so nothing but a Ruchoir release installs. A new
//! version is announced to the interface (`update:available`) and installed only on the person's
//! click ("Restart to update"). Installs from a `.deb` or a `.rpm` cannot replace themselves: they
//! are told, with the download page, and the person updates as they installed. A check or a download
//! that fails is logged and tried again at the next check; nothing half-installed is left.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// How often a running app asks again.
const EVERY: Duration = Duration::from_secs(6 * 3600);
/// Where an install that cannot update itself sends the person.
pub const DOWNLOAD_PAGE: &str = "https://ruchoir.com/desktop/";

/// A newer version, as the interface shows it.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateOffer {
    pub version: String,
    /// True for an install the app cannot replace (`.deb`, `.rpm`): the download page instead.
    pub manual: bool,
}

/// The update found last, kept until it is installed.
#[derive(Default)]
pub struct Updates {
    found: Mutex<Option<Update>>,
    offer: Mutex<Option<UpdateOffer>>,
}

/// Whether this install is a system package, which only the system's package tools may replace.
fn system_package() -> bool {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    matches!(bundle_type(), Some(BundleType::Deb | BundleType::Rpm))
}

/// Ask now, then every six hours, for as long as the app runs.
pub fn watch<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            check(&app).await;
            tokio::time::sleep(EVERY).await;
        }
    });
}

async fn check<R: Runtime>(app: &AppHandle<R>) {
    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(error) => {
            eprintln!("ruchoir: the updater is not available: {error}");
            return;
        }
    };
    let update = match found {
        Ok(Some(update)) => update,
        Ok(None) => return,
        Err(error) => {
            eprintln!("ruchoir: the update check failed: {error}");
            return;
        }
    };
    let offer = UpdateOffer {
        version: update.version.clone(),
        manual: system_package(),
    };
    let updates = app.state::<Updates>();
    if let Ok(mut found) = updates.found.lock() {
        *found = Some(update);
    }
    if let Ok(mut kept) = updates.offer.lock() {
        *kept = Some(offer.clone());
    }
    let _ = app.emit("update:available", offer);
}

/// The newer version found so far, for an interface that was not listening yet.
#[tauri::command]
pub fn update_state(updates: State<'_, Updates>) -> Option<UpdateOffer> {
    updates.offer.lock().ok().and_then(|offer| offer.clone())
}

/// "Restart to update": download, check the signature, install, start the new version. An install
/// that cannot replace itself opens the download page instead.
#[tauri::command]
pub async fn update_install<R: Runtime>(
    app: AppHandle<R>,
    updates: State<'_, Updates>,
) -> Result<(), String> {
    if system_package() {
        use tauri_plugin_opener::OpenerExt;
        return app
            .opener()
            .open_url(DOWNLOAD_PAGE, None::<&str>)
            .map_err(|_| "no_browser".to_owned());
    }
    let update = updates
        .found
        .lock()
        .ok()
        .and_then(|found| found.clone())
        .ok_or("no_update")?;
    if let Err(error) = update.download_and_install(|_, _| {}, || {}).await {
        eprintln!("ruchoir: the update could not be installed: {error}");
        // Kept for another try from the same offer.
        return Err("failed".into());
    }
    app.restart();
}
