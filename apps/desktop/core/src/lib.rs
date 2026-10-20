//! The desktop app's logic that needs no window.
//!
//! Everything here runs without Tauri or a webview, so it is tested on any machine (the pull request
//! check builds this crate alone, without WebKitGTK). `src-tauri` is the thin glue that wires these
//! pieces to the window, the system's keychain and the deep links.

pub mod auth;
pub mod instances;
pub mod vault;

/// The HTTP client every request to an instance goes through: rustls with the system's roots (an
/// instance behind a company's own authority works), no cookie store, and a user agent that names
/// the app so the instance's session list can say which device a session is.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(format!(
            "Ruchoir-Desktop/{} ({})",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS
        ))
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("the HTTP client builds")
}
