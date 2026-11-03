//! File windows. The viewer's "open in a new tab" has no tab to open in here, so the interface asks
//! for a window of its own: a decorated one showing a file's bytes (its preview, or the converted
//! document) on the app's protocol, which the webview renders as a browser tab would (a PDF, an
//! image). Only those two paths are accepted. The window shows a file and no interface, and holds
//! no capability, so no command can be called from it. What keeps a script in an SVG or HTML file
//! from running there is the response's policy (the instance's own, or `INLINE_FILE_CSP` added by
//! the core's proxy), not this window. It follows the main window's rules for navigation, new
//! windows and downloads.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Instant, SystemTime};

use ruchoir_desktop_core::files::{
    forget_instance_copies, hash_bytes, is_file_bytes_path, local_path, multipart_file, open_root,
    own_path, step, sweep_old_copies, window_label, window_title, Seen, Watched, Watches, LIFETIME,
    POLL,
};
use ruchoir_desktop_core::proxy;
use serde::Serialize;
use tauri::http::{header, HeaderMap, HeaderValue, Method};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::state::Desktop;

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

/// What the interface is told when an opened file is saved (`file:saved`).
#[derive(Clone, Serialize)]
pub struct Saved {
    pub instance: String,
    pub file_id: String,
    pub name: String,
    pub base_version: String,
}

/// The copies being watched, and the uploads running. One upload per file at a time: a second
/// `file_send_version` for the same file answers `busy` rather than queueing (the banner is gone
/// as soon as the first one is accepted, so a second call is a double click).
#[derive(Default)]
pub struct Watcher {
    watches: Mutex<Watches>,
    sending: Mutex<HashSet<(String, String)>>,
}

impl Watcher {
    fn is_sending(&self, instance: &str, file_id: &str) -> bool {
        self.sending
            .lock()
            .is_ok_and(|s| s.contains(&(instance.to_owned(), file_id.to_owned())))
    }
}

/// Holds a file's upload slot and gives it back however the upload ends.
struct Sending<'a> {
    watcher: &'a Watcher,
    key: (String, String),
}

impl<'a> Sending<'a> {
    fn take(watcher: &'a Watcher, instance: &str, file_id: &str) -> Option<Self> {
        let key = (instance.to_owned(), file_id.to_owned());
        let first = watcher.sending.lock().ok()?.insert(key.clone());
        first.then_some(Self { watcher, key })
    }
}

impl Drop for Sending<'_> {
    fn drop(&mut self) {
        if let Ok(mut s) = self.watcher.sending.lock() {
            s.remove(&self.key);
        }
    }
}

pub fn emit_saved<R: Runtime>(app: &AppHandle<R>, saved: &Saved) {
    let _ = app.emit("file:saved", saved);
}

fn open_folder<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    Ok(open_root(
        &app.path().app_cache_dir().map_err(|_| "failed")?,
    ))
}

/// Download a file to the cache, open it with the computer's app and, when `base_version` is given
/// (the person may add a version), watch it for saves. The copy is replaced at each opening.
/// Errors: `refused` (a link or id that is not the app's own), `signed_out`, `unreachable`,
/// `no_app` (nothing on the computer opens it), `failed`.
#[tauri::command]
pub async fn file_open_local<R: Runtime>(
    app: AppHandle<R>,
    instance: String,
    file_id: String,
    name: String,
    href: String,
    base_version: Option<String>,
) -> Result<(), String> {
    let path = local_path(&open_folder(&app)?, &instance, &file_id, &name).ok_or("refused")?;
    let bytes = crate::downloads::fetch(&app, &href).await?;
    let folder = path.parent().ok_or("failed")?;
    tokio::fs::create_dir_all(folder)
        .await
        .map_err(|_| "failed")?;
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|_| "failed")?;
    let mtime = tokio::fs::metadata(&path)
        .await
        .ok()
        .and_then(|m| m.modified().ok());
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|_| "no_app".to_owned())?;
    if let Some(base_version) = base_version {
        let watched = Watched {
            instance,
            file_id,
            name,
            path,
            base_version,
            hash: hash_bytes(&bytes),
            mtime,
            since: Instant::now(),
            settling: None,
        };
        if let Ok(mut list) = app.state::<Watcher>().watches.lock() {
            list.insert(watched);
        }
    }
    Ok(())
}

/// The person turned the offer down: the file is no longer watched (opening it again restarts it).
#[tauri::command]
pub fn file_dismiss(watcher: tauri::State<'_, Watcher>, instance: String, file_id: String) {
    if let Ok(mut list) = watcher.watches.lock() {
        list.remove(&instance, &file_id);
    }
}

/// Send the saved copy as a new version of its file, with the instance's session. On success the
/// watch ends, unless a newer save is already waiting. Errors: `busy` (an upload of this file is
/// running), `not_watched` (the watch ended or never began), `signed_out`, `unreachable`, `failed`.
#[tauri::command]
pub async fn file_send_version<R: Runtime>(
    app: AppHandle<R>,
    instance: String,
    file_id: String,
) -> Result<(), String> {
    let watcher = app.state::<Watcher>();
    let _slot = Sending::take(&watcher, &instance, &file_id).ok_or("busy")?;
    let (path, name) = {
        let mut list = watcher.watches.lock().map_err(|_| "failed")?;
        let w = list.find(&instance, &file_id).ok_or("not_watched")?;
        (w.path.clone(), w.name.clone())
    };
    let bytes = tokio::fs::read(&path).await.map_err(|_| "failed")?;
    let hash = hash_bytes(&bytes);
    let desktop = app.state::<Desktop>();
    let (origin, token) = desktop.credentials(&instance).ok_or("signed_out")?;
    let token = token.ok_or("signed_out")?;
    let mut random = [0u8; 12];
    getrandom::fill(&mut random).map_err(|_| "failed")?;
    let boundary: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let boundary = format!("ruchoir{boundary}");
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&format!("multipart/form-data; boundary={boundary}"))
            .map_err(|_| "failed")?,
    );
    let answer = proxy::forward(
        &desktop.http,
        Method::POST,
        &format!("/api/v1/files/{file_id}/versions"),
        &headers,
        multipart_file(&boundary, &name, &bytes),
        &origin,
        Some(&token),
    )
    .await;
    match answer.status {
        200..=299 => {
            if let Ok(mut list) = watcher.watches.lock() {
                if let Some(w) = list.find(&instance, &file_id) {
                    w.mark_sent(hash);
                    // A save made while this one was going up stays offered.
                    if w.settling.is_none() {
                        list.remove(&instance, &file_id);
                    }
                }
            }
            Ok(())
        }
        401 => Err("signed_out".into()),
        502 => Err("unreachable".into()),
        _ => Err("failed".into()),
    }
}

/// "Save as" for the local copy, nothing uploaded. False when the person cancelled.
#[tauri::command]
pub async fn file_keep_copy<R: Runtime>(
    app: AppHandle<R>,
    instance: String,
    file_id: String,
) -> Result<bool, String> {
    let (path, name) = {
        let watcher = app.state::<Watcher>();
        let mut list = watcher.watches.lock().map_err(|_| "failed")?;
        let w = list.find(&instance, &file_id).ok_or("not_watched")?;
        (w.path.clone(), w.name.clone())
    };
    let Some(target) = crate::downloads::choose_save_path(&app, &name).await? else {
        return Ok(false);
    };
    tokio::fs::copy(&path, &target)
        .await
        .map_err(|_| "not_saved")?;
    Ok(true)
}

/// An instance signed out or removed: stop watching its copies and delete them.
pub fn forget_instance<R: Runtime>(app: &AppHandle<R>, instance: &str) {
    if let Some(watcher) = app.try_state::<Watcher>() {
        if let Ok(mut list) = watcher.watches.lock() {
            list.forget_instance(instance);
        }
    }
    if let Ok(root) = open_folder(app) {
        forget_instance_copies(&root, instance);
    }
}

/// Start the watching task and clear the copies left by earlier runs. Called once, in `setup`.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(root) = open_folder(app) {
        // Off the setup path: a big cache folder must not hold the window back.
        tauri::async_runtime::spawn_blocking(move || {
            sweep_old_copies(&root, SystemTime::now(), LIFETIME);
        });
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(POLL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            round(&app).await;
        }
    });
}

/// The modification time and, only when it moved since `last`, the hash. `None` when the time is
/// unchanged or the file cannot be read right now (an editor may swap it for a moment).
fn look(path: &std::path::Path, last: Option<SystemTime>) -> Option<(SystemTime, [u8; 32])> {
    let mtime = std::fs::metadata(path).ok()?.modified().ok()?;
    if Some(mtime) == last {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some((mtime, hash_bytes(&bytes)))
}

async fn round<R: Runtime>(app: &AppHandle<R>) {
    let watcher = app.state::<Watcher>();
    // Nothing watched: nothing to do but wait for the next tick.
    let snapshot = match watcher.watches.lock() {
        Ok(list) if !list.is_empty() => list.snapshot(),
        _ => return,
    };
    for (instance, file_id, path, last) in snapshot {
        // An upload is running: its outcome decides what comes next, so this file is left alone.
        if watcher.is_sending(&instance, &file_id) {
            continue;
        }
        let observed = tauri::async_runtime::spawn_blocking(move || look(&path, last))
            .await
            .ok()
            .flatten();
        let now = Instant::now();
        let saved = {
            let Ok(mut list) = watcher.watches.lock() else {
                return;
            };
            let Some(w) = list.find(&instance, &file_id) else {
                continue;
            };
            match step(w, now, observed) {
                Seen::Saved(_) => Some(Saved {
                    instance: w.instance.clone(),
                    file_id: w.file_id.clone(),
                    name: w.name.clone(),
                    base_version: w.base_version.clone(),
                }),
                Seen::Expired => {
                    list.remove(&instance, &file_id);
                    None
                }
                Seen::Unchanged | Seen::Settling => None,
            }
        };
        if let Some(saved) = saved {
            emit_saved(app, &saved);
            crate::notify::announce_saved(app, &saved);
        }
    }
}
