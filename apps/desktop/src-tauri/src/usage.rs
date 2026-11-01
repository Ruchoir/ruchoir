//! Ruchoir's anonymous usage statistics (decided by Théo, 2026-11-01): how many desktop apps are in
//! use, by version and system. Each installation draws a random identifier the first time it asks
//! for updates, unrelated to any account, instance or person, and sends it with that request
//! (`X-Ruchoir-Install`), with the app's version and installation format. The website's server logs
//! those three fields, without the address, and counts the identifiers seen in a day, a week and a
//! month. Preferences, Application, turns it off: no identifier is sent any more, and the stored one
//! is erased, so turning it on again starts a new one that cannot be tied to the old.

use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

const STORE: &str = "desktop.json";
const KEY: &str = "install_id";

/// A random identifier: 128 bits, as 32 hexadecimal characters.
fn draw() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// This installation's identifier, drawn on first use; `None` when counting is off.
pub fn install_id<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    if !crate::shell::read_settings(app).usage_count {
        return None;
    }
    let store = app.store(STORE).ok()?;
    if let Some(id) = store.get(KEY).and_then(|v| v.as_str().map(str::to_owned)) {
        if is_valid(&id) {
            return Some(id);
        }
    }
    let id = draw()?;
    store.set(KEY, serde_json::Value::String(id.clone()));
    let _ = store.save();
    Some(id)
}

/// Erase the identifier (counting turned off).
pub fn forget<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(store) = app.store(STORE) {
        store.delete(KEY);
        let _ = store.save();
    }
}

fn is_valid(id: &str) -> bool {
    id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_identifier_is_32_random_hex_characters() {
        let a = draw().expect("random");
        let b = draw().expect("random");
        assert!(is_valid(&a) && is_valid(&b));
        assert_ne!(a, b);
        assert!(!is_valid("not-an-id"));
    }
}
