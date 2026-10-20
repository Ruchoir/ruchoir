//! The desktop app's logic that needs no window.
//!
//! Everything here runs without Tauri or a webview, so it is tested on any machine (the pull request
//! check builds this crate alone, without WebKitGTK). `src-tauri` is the thin glue that wires these
//! pieces to the window, the system's keychain and the deep links.

pub mod instances;
pub mod vault;
