//! Downloads. A browser saves what a download link points at by itself; the app's webview does not
//! (WebView2 did nothing at all), so the interface hands its download links to the core: they are
//! read from the instance through the app's protocol rules, with the session the core keeps, then
//! either saved where the person chooses (the system's "Save as" dialog) or opened in the system's
//! own app for them (the calendar's PDF, to print). Only the app's own API paths are fetched: a link
//! anywhere else is refused.

use ruchoir_desktop_core::proxy::{self, Route};
use tauri::http::{HeaderMap, Method};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::state::Desktop;

/// The path and query of a link of the app's own origin (or a relative one); `None` for any other.
fn own_path(href: &str) -> Option<String> {
    if href.starts_with('/') && !href.starts_with("//") {
        return Some(href.to_owned());
    }
    let url = tauri::Url::parse(href).ok()?;
    let own = match url.scheme() {
        "http" => url.host_str() == Some("ruchoir-app.localhost"),
        scheme => scheme == crate::APP_SCHEME && url.host_str() == Some("localhost"),
    };
    if !own {
        return None;
    }
    Some(match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    })
}

/// A file name the system will take: no folder in it, no control character, never empty.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_owned();
    if cleaned.is_empty() {
        "download".to_owned()
    } else {
        cleaned
    }
}

/// The bytes behind one of the app's API links, read with the instance's session.
async fn fetch<R: Runtime>(app: &AppHandle<R>, href: &str) -> Result<Vec<u8>, String> {
    let path = own_path(href).ok_or("refused")?;
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
        401 => Err("signed_out".into()),
        502 => Err("unreachable".into()),
        _ => Err("failed".into()),
    }
}

/// Ask where to save `name`, then save what `href` points at there. False when the person cancelled.
pub async fn save<R: Runtime>(app: &AppHandle<R>, href: &str, name: &str) -> Result<bool, String> {
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
    let Some(chosen) = chosen else {
        return Ok(false);
    };
    let path = chosen.into_path().map_err(|_| "failed")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_apps_own_links_are_fetched() {
        assert_eq!(
            own_path("/api/v1/files/a/download").as_deref(),
            Some("/api/v1/files/a/download")
        );
        assert_eq!(
            own_path("ruchoir-app://localhost/i/x/api/v1/calendar/print?view=week").as_deref(),
            Some("/i/x/api/v1/calendar/print?view=week")
        );
        assert_eq!(
            own_path("http://ruchoir-app.localhost/api/v1/files/a").as_deref(),
            Some("/api/v1/files/a")
        );
        assert_eq!(own_path("https://example.org/api/v1/files/a"), None);
        assert_eq!(own_path("//example.org/api/v1/files/a"), None);
        assert_eq!(own_path("http://ruchoir-app.localhost.evil.org/x"), None);
    }

    #[test]
    fn a_name_never_leaves_its_folder() {
        assert_eq!(safe_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_name("Agenda: semaine?.pdf"), "Agenda_ semaine_.pdf");
        assert_eq!(safe_name("  "), "download");
        assert_eq!(safe_name("..."), "download");
        assert_eq!(safe_name("Devis 2026.pdf"), "Devis 2026.pdf");
    }
}
