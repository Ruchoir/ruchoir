//! Rules shared by the downloads and the file windows: which links are the app's own, what a file
//! name may contain, and the stable label of a viewer window.
//!
//! Kept free of Tauri so they are tested on any machine. A viewer window is keyed by the path it
//! shows, so opening the same file twice brings the first window forward instead of piling up copies.

use sha2::{Digest, Sha256};

/// The path and query of a link of the app's own origin (or a relative one); `None` for any other.
/// `scheme` is the custom protocol's name; Windows spells that origin as `http://<scheme>.localhost`.
pub fn own_path(href: &str, scheme: &str) -> Option<String> {
    if href.starts_with('/') && !href.starts_with("//") {
        return Some(href.to_owned());
    }
    let url = url::Url::parse(href).ok()?;
    let own = match url.scheme() {
        "http" => url.host_str() == Some(&format!("{scheme}.localhost")),
        s => s == scheme && url.host_str() == Some("localhost"),
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
pub fn safe_name(name: &str) -> String {
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

/// The label of the window showing `path`: `viewer-` and the first 16 hex characters of its sha256
/// (a path holds characters a label does not allow, and the hash is the same each time).
pub fn window_label(path: &str) -> String {
    let digest = Sha256::digest(path.as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("viewer-{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCHEME: &str = "ruchoir-app";

    #[test]
    fn only_the_apps_own_links_are_fetched() {
        assert_eq!(
            own_path("/api/v1/files/a/download", SCHEME).as_deref(),
            Some("/api/v1/files/a/download")
        );
        assert_eq!(
            own_path(
                "ruchoir-app://localhost/i/x/api/v1/calendar/print?view=week",
                SCHEME
            )
            .as_deref(),
            Some("/i/x/api/v1/calendar/print?view=week")
        );
        assert_eq!(
            own_path("http://ruchoir-app.localhost/api/v1/files/a", SCHEME).as_deref(),
            Some("/api/v1/files/a")
        );
        assert_eq!(own_path("https://example.org/api/v1/files/a", SCHEME), None);
        assert_eq!(own_path("//example.org/api/v1/files/a", SCHEME), None);
        assert_eq!(
            own_path("http://ruchoir-app.localhost.evil.org/x", SCHEME),
            None
        );
    }

    #[test]
    fn a_name_never_leaves_its_folder() {
        assert_eq!(safe_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_name("Agenda: semaine?.pdf"), "Agenda_ semaine_.pdf");
        assert_eq!(safe_name("  "), "download");
        assert_eq!(safe_name("..."), "download");
        assert_eq!(safe_name("Devis 2026.pdf"), "Devis 2026.pdf");
    }

    #[test]
    fn a_window_label_is_stable_per_path() {
        let a = window_label("/i/x/api/v1/files/a/content");
        assert_eq!(a, window_label("/i/x/api/v1/files/a/content"));
        assert_ne!(a, window_label("/i/x/api/v1/files/b/content"));
        assert!(a.starts_with("viewer-"));
        assert_eq!(a.len(), "viewer-".len() + 16);
        assert!(a["viewer-".len()..].chars().all(|c| c.is_ascii_hexdigit()));
    }
}
