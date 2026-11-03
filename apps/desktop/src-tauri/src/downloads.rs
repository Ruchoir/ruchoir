//! Downloads. A browser saves what a download link points at by itself; the app's webview does not
//! (WebView2 did nothing at all), so the interface hands its download links to the core: they are
//! read from the instance through the app's protocol rules, with the session the core keeps, then
//! either saved where the person chooses (the system's "Save as" dialog) or opened in the system's
//! own app for them (the calendar's PDF, to print). Only the app's own API paths are fetched: a link
//! anywhere else is refused.

use ruchoir_desktop_core::files::{own_path, safe_name};
use ruchoir_desktop_core::proxy::{self, Route};
use tauri::http::{HeaderMap, Method};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::state::Desktop;

/// The bytes behind one of the app's API links, read with the instance's session.
pub(crate) async fn fetch<R: Runtime>(app: &AppHandle<R>, href: &str) -> Result<Vec<u8>, String> {
    let path = own_path(href, crate::APP_SCHEME).ok_or("refused")?;
    let (bare, query) = match path.split_once('?') {
        Some((bare, query)) => (bare.to_owned(), format!("?{query}")),
        None => (path.clone(), String::new()),
    };
    let desktop = app.state::<Desktop>();
    let (instance, rest) = match proxy::route(&bare) {
        Route::Api { instance, rest } => (instance, rest),
        Route::OpenApi(rest) => (desktop.view().id.ok_or("signed_out")?, rest),
        Route::Emoji(_) | Route::Asset(_) => return Err("refused".into()),
    };
    let (origin, token) = desktop.credentials(&instance).ok_or("signed_out")?;
    let token = token.ok_or("signed_out")?;
    let answer = proxy::forward(
        &desktop.http,
        Method::GET,
        &format!("{rest}{query}"),
        &HeaderMap::new(),
        Vec::new(),
        &origin,
        Some(&token),
    )
    .await;
    match answer.status {
        200..=299 => Ok(answer.body),
        401 => {
            crate::notify::signed_out(app, &instance);
            Err("signed_out".into())
        }
        502 => Err("unreachable".into()),
        _ => Err("failed".into()),
    }
}

/// Ask where to save `name` with the system's "Save as" dialog; `None` when the person cancelled.
pub(crate) async fn choose_save_path<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    let name = safe_name(name);
    let asking = app.clone();
    // The dialog waits for the person: off the async workers, which keep the app's sockets.
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        asking
            .dialog()
            .file()
            .set_file_name(name)
            .blocking_save_file()
    })
    .await
    .map_err(|_| "failed")?;
    match chosen {
        Some(chosen) => Ok(Some(chosen.into_path().map_err(|_| "failed")?)),
        None => Ok(None),
    }
}

/// Ask where to save `name`, then save what `href` points at there. False when the person cancelled.
pub async fn save<R: Runtime>(app: &AppHandle<R>, href: &str, name: &str) -> Result<bool, String> {
    let Some(path) = choose_save_path(app, name).await? else {
        return Ok(false);
    };
    let bytes = fetch(app, href).await?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|_| "not_saved")?;
    Ok(true)
}

/// "Save as" for one of the interface's download links.
#[tauri::command]
pub async fn download_save<R: Runtime>(
    app: AppHandle<R>,
    href: String,
    name: String,
) -> Result<bool, String> {
    save(&app, &href, &name).await
}

/// Open what `href` points at in the system's app for it (the calendar's PDF, to print from there),
/// through a copy in the app's cache, replaced at each opening.
#[tauri::command]
pub async fn download_open<R: Runtime>(
    app: AppHandle<R>,
    href: String,
    name: String,
) -> Result<(), String> {
    let bytes = fetch(&app, &href).await?;
    let folder = app
        .path()
        .app_cache_dir()
        .map_err(|_| "failed")?
        .join("opened");
    tokio::fs::create_dir_all(&folder)
        .await
        .map_err(|_| "failed")?;
    let path = folder.join(safe_name(&name));
    tokio::fs::write(&path, bytes).await.map_err(|_| "failed")?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|_| "no_app".to_owned())
}
