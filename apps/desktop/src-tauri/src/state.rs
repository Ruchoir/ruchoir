//! What the app holds while it runs: the instance list, the token vault, the sign-in in progress,
//! and the commands the interface calls to drive them.
//!
//! The interface learns of every change through the `instances:changed` event (every instance) and
//! `instance:changed` (the open one), and never receives a token: no command returns one, and no
//! event carries one.

use std::path::PathBuf;
use std::sync::Mutex;

use ruchoir_desktop_core::auth::{self, PendingSignIn};
use ruchoir_desktop_core::instances::{
    check_instance, normalise_origin_with, origin_host, CheckError, Instance, InstanceList,
    OriginError, CHECK_WITHIN,
};
use ruchoir_desktop_core::vault::TokenVault;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;

/// Everything the app keeps between two commands.
pub struct Desktop {
    pub list: Mutex<InstanceList>,
    pub vault: Box<dyn TokenVault>,
    pub pending: Mutex<Option<PendingSignIn>>,
    pub http: reqwest::Client,
    pub list_path: PathBuf,
}

/// What the interface knows of an instance.
#[derive(Debug, Clone, Serialize)]
pub struct InstanceView {
    pub id: Option<String>,
    pub origin: Option<String>,
    pub name: Option<String>,
    /// `none`, `signed_out`, `signing_in` or `signed_in`.
    pub state: &'static str,
    pub vault_persistent: bool,
    /// The instance the interface shows.
    pub open: bool,
}

impl Desktop {
    pub fn new(list_path: PathBuf, vault: Box<dyn TokenVault>) -> Self {
        Self {
            list: Mutex::new(InstanceList::load(&list_path)),
            vault,
            pending: Mutex::new(None),
            http: ruchoir_desktop_core::http_client(),
            list_path,
        }
    }

    /// The open instance as the interface sees it.
    pub fn view(&self) -> InstanceView {
        let list = self.list.lock().expect("instance list");
        match list.active() {
            Some(instance) => self.view_of(instance, true),
            None => InstanceView {
                id: None,
                origin: None,
                name: None,
                state: "none",
                vault_persistent: self.vault.persistent(),
                open: false,
            },
        }
    }

    /// Every instance, in the list's order.
    pub fn views(&self) -> Vec<InstanceView> {
        let list = self.list.lock().expect("instance list");
        let open = list.active().map(|i| i.id.clone());
        list.instances
            .iter()
            .map(|i| self.view_of(i, open.as_deref() == Some(i.id.as_str())))
            .collect()
    }

    fn view_of(&self, instance: &Instance, open: bool) -> InstanceView {
        let signing_in = self
            .pending
            .lock()
            .ok()
            .and_then(|p| p.as_ref().map(|p| p.instance_id == instance.id))
            .unwrap_or(false);
        let state = if self.vault.get(&instance.id).is_some() {
            "signed_in"
        } else if signing_in {
            "signing_in"
        } else {
            "signed_out"
        };
        InstanceView {
            id: Some(instance.id.clone()),
            origin: Some(instance.origin.clone()),
            name: Some(instance.name.clone()),
            state,
            vault_persistent: self.vault.persistent(),
            open,
        }
    }

    /// Save the list after a change.
    fn save(&self, list: &InstanceList) -> Result<(), String> {
        list.save(&self.list_path)
            .map_err(|_| "internal".to_string())
    }

    /// The origin and token of an instance, for the proxy and the watcher.
    pub fn credentials(&self, id: &str) -> Option<(String, Option<String>)> {
        let origin = self.list.lock().ok()?.get(id)?.origin.clone();
        Some((origin, self.vault.get(id)))
    }

    /// The origin of the instance the interface shows.
    pub fn active_origin(&self) -> Option<String> {
        Some(self.list.lock().ok()?.active()?.origin.clone())
    }

    /// Forget an instance's session (a 401, or a sign-out from the interface).
    pub fn forget_session(&self, id: &str) {
        self.vault.forget(id);
    }
}

/// Tell the interface the instances changed (and start or stop their watchers to match).
pub fn changed<R: Runtime>(app: &AppHandle<R>) {
    crate::relay::reconcile(app);
    let desktop = app.state::<Desktop>();
    let _ = app.emit("instance:changed", desktop.view());
    let _ = app.emit("instances:changed", desktop.views());
}

fn origin_error(error: OriginError) -> String {
    match error {
        OriginError::Empty => "empty",
        OriginError::NotHttps => "not_https",
        OriginError::HasPath => "has_path",
        OriginError::HasCredentials => "has_credentials",
        OriginError::Invalid => "invalid",
    }
    .to_string()
}

#[tauri::command]
pub fn instance_state(desktop: State<'_, Desktop>) -> InstanceView {
    desktop.view()
}

#[tauri::command]
pub fn instances_state(desktop: State<'_, Desktop>) -> Vec<InstanceView> {
    desktop.views()
}

/// Show another instance.
#[tauri::command]
pub fn instance_open<R: Runtime>(
    app: AppHandle<R>,
    desktop: State<'_, Desktop>,
    id: String,
) -> Result<(), String> {
    {
        let mut list = desktop.list.lock().map_err(|_| "internal")?;
        if !list.open(&id) {
            return Err("unknown_instance".into());
        }
        desktop.save(&list)?;
    }
    changed(&app);
    Ok(())
}

/// Forget an instance: its session, its summary, its place in the list.
#[tauri::command]
pub fn instance_remove<R: Runtime>(
    app: AppHandle<R>,
    desktop: State<'_, Desktop>,
    id: String,
) -> Result<(), String> {
    desktop.forget_session(&id);
    {
        let mut list = desktop.list.lock().map_err(|_| "internal")?;
        list.remove(&id);
        desktop.save(&list)?;
    }
    crate::summaries::forget(&app, &id);
    changed(&app);
    Ok(())
}

/// End the session on an instance (the instance is told, then the token forgotten); the instance
/// stays in the list, signed out.
#[tauri::command]
pub async fn instance_sign_out<R: Runtime>(
    app: AppHandle<R>,
    desktop: State<'_, Desktop>,
    id: String,
) -> Result<(), String> {
    if let Some((origin, Some(token))) = desktop.credentials(&id) {
        let _ = desktop
            .http
            .post(format!("{origin}/api/v1/auth/logout"))
            .bearer_auth(token)
            .send()
            .await;
    }
    desktop.forget_session(&id);
    changed(&app);
    Ok(())
}

/// Add the instance at `address` once it answers as a Ruchoir instance able to give an app its own
/// session. Errors are codes the interface translates.
#[tauri::command]
pub async fn instance_add<R: Runtime>(
    app: AppHandle<R>,
    desktop: State<'_, Desktop>,
    address: String,
) -> Result<InstanceView, String> {
    let origin = normalise_origin_with(&address, cfg!(debug_assertions)).map_err(origin_error)?;
    check_instance(&desktop.http, &origin, CHECK_WITHIN)
        .await
        .map_err(|error| {
            match error {
                CheckError::Unreachable => "unreachable",
                CheckError::NotRuchoir => "not_ruchoir",
                CheckError::Outdated => "outdated",
            }
            .to_string()
        })?;
    let host = origin_host(&origin).to_string();
    {
        let mut list = desktop.list.lock().map_err(|_| "internal")?;
        list.add(origin, host)
            .map_err(|_| "already_added".to_string())?;
        desktop.save(&list)?;
    }
    changed(&app);
    Ok(desktop.view())
}

/// Open an instance's sign-in page in the system browser (the open instance when none is named).
#[tauri::command]
pub fn sign_in_start<R: Runtime>(
    app: AppHandle<R>,
    desktop: State<'_, Desktop>,
    id: Option<String>,
) -> Result<(), String> {
    let (id, origin) = {
        let list = desktop.list.lock().map_err(|_| "internal")?;
        let instance = match &id {
            Some(id) => list.get(id),
            None => list.active(),
        }
        .ok_or("no_instance")?;
        (instance.id.clone(), instance.origin.clone())
    };
    let pending = auth::begin(&id);
    let url = auth::sign_in_url(&origin, &pending);
    *desktop.pending.lock().map_err(|_| "internal")? = Some(pending);
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "browser".to_string())?;
    changed(&app);
    Ok(())
}

/// Give up waiting for the page.
#[tauri::command]
pub fn sign_in_cancel<R: Runtime>(app: AppHandle<R>, desktop: State<'_, Desktop>) {
    if let Ok(mut pending) = desktop.pending.lock() {
        *pending = None;
    }
    changed(&app);
}

/// A `ruchoir://` link reached the app (first launch, or a second launch handed over).
pub async fn handle_deep_link<R: Runtime>(app: AppHandle<R>, link: String) {
    let desktop = app.state::<Desktop>();
    let pending = desktop.pending.lock().ok().and_then(|p| p.clone());
    let origin = pending
        .as_ref()
        .and_then(|p| desktop.credentials(&p.instance_id))
        .map(|(origin, _)| origin)
        .unwrap_or_default();
    let Some(result) = auth::complete(&desktop.http, pending.as_ref(), &origin, &link).await else {
        return;
    };
    if let Ok(mut slot) = desktop.pending.lock() {
        *slot = None;
    }
    match result {
        Ok(token) => {
            let id = pending.map(|p| p.instance_id).unwrap_or_default();
            if let Err(error) = desktop.vault.set(&id, &token) {
                let _ = app.emit("sign-in:failed", error.to_string());
            }
        }
        Err(error) => {
            let _ = app.emit("sign-in:failed", error.to_string());
        }
    }
    changed(&app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
