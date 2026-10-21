//! What the app holds while it runs: the instance list, the token vault, the sign-in in progress,
//! and the commands the interface calls to drive them.
//!
//! The interface learns of every change through the `instance:changed` event and never receives a
//! token: no command returns one, and no event carries one.

use std::path::PathBuf;
use std::sync::Mutex;

use ruchoir_desktop_core::auth::{self, PendingSignIn};
use ruchoir_desktop_core::instances::{
    check_instance, normalise_origin, CheckError, InstanceList, OriginError, CHECK_WITHIN,
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

/// What the interface knows of the instance it shows.
#[derive(Debug, Clone, Serialize)]
pub struct InstanceView {
    pub id: Option<String>,
    pub origin: Option<String>,
    pub name: Option<String>,
    /// `none`, `signed_out`, `signing_in` or `signed_in`.
    pub state: &'static str,
    pub vault_persistent: bool,
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

    /// The active instance as the interface sees it.
    pub fn view(&self) -> InstanceView {
        let list = self.list.lock().expect("instance list");
        let persistent = self.vault.persistent();
        let Some(instance) = list.active() else {
            return InstanceView {
                id: None,
                origin: None,
                name: None,
                state: "none",
                vault_persistent: persistent,
            };
        };
        let pending = self.pending.lock().expect("pending sign-in");
        let state = if self.vault.get(&instance.id).is_some() {
            "signed_in"
        } else if pending
            .as_ref()
            .is_some_and(|p| p.instance_id == instance.id)
        {
            "signing_in"
        } else {
            "signed_out"
        };
        InstanceView {
            id: Some(instance.id.clone()),
            origin: Some(instance.origin.clone()),
            name: Some(instance.name.clone()),
            state,
            vault_persistent: persistent,
        }
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

/// Tell the interface the instance changed.
pub fn changed<R: Runtime>(app: &AppHandle<R>) {
    crate::relay::reconcile(app);
    let view = app.state::<Desktop>().view();
    let _ = app.emit("instance:changed", view);
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

/// Add the instance at `address` once it answers as a Ruchoir instance able to give an app its own
/// session. Errors are codes the interface translates.
#[tauri::command]
pub async fn instance_add<R: Runtime>(
    app: AppHandle<R>,
    desktop: State<'_, Desktop>,
    address: String,
) -> Result<InstanceView, String> {
    let origin = normalise_origin(&address).map_err(origin_error)?;
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
    let host = origin.trim_start_matches("https://").to_string();
    {
        let mut list = desktop.list.lock().map_err(|_| "internal")?;
        list.add(origin, host)
            .map_err(|_| "already_added".to_string())?;
        list.save(&desktop.list_path).map_err(|_| "internal")?;
    }
    changed(&app);
    Ok(desktop.view())
}

/// Open the instance's sign-in page in the system browser.
#[tauri::command]
pub fn sign_in_start<R: Runtime>(
    app: AppHandle<R>,
    desktop: State<'_, Desktop>,
) -> Result<(), String> {
    let (id, origin) = {
        let list = desktop.list.lock().map_err(|_| "internal")?;
        let instance = list.active().ok_or("no_instance")?;
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
