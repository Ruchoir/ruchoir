//! Rules shared by the downloads and the file windows: which links are the app's own, what a file
//! name may contain, and the stable label of a viewer window.
//!
//! Kept free of Tauri so they are tested on any machine. A viewer window is keyed by the path it
//! shows, so opening the same file twice brings the first window forward instead of piling up copies.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use sha2::{Digest, Sha256};

/// The path and query of a link of the app's own origin (or a relative one); `None` for any other.
/// `scheme` is the custom protocol's name; Windows spells that origin as `http://<scheme>.localhost`.
pub fn own_path(href: &str, scheme: &str) -> Option<String> {
    let path = own_path_unchecked(href, scheme)?;
    // A path that starts with two slashes (or a slash and a backslash, which the URL parser reads
    // the same way) is host-relative once joined to the app's origin: it would name another site.
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return None;
    }
    Some(path)
}

fn own_path_unchecked(href: &str, scheme: &str) -> Option<String> {
    if href.starts_with('/') {
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

/// The title of a viewer window: the file's name as the person knows it, so punctuation stays (a
/// title is no path); control characters go, and it is cut to 120 characters. Never empty.
pub fn window_title(title: &str) -> String {
    // Control characters and bidirectional overrides (they reorder the text around them) go.
    let cleaned: String = title
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
        })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return "Ruchoir".to_owned();
    }
    if cleaned.chars().count() > 120 {
        let cut: String = cleaned.chars().take(120).collect();
        return format!("{}...", cut.trim_end());
    }
    cleaned.to_owned()
}

/// Whether `path` (path and query) is the bytes of a file: its preview, or the converted document
/// the viewer shows for an office file, of an instance. Only those open in a file window: they are
/// the paths the API serves with a script-less policy, and nothing else of the API belongs in a
/// window of its own.
pub fn is_file_bytes_path(path: &str) -> bool {
    let path = path.split_once('?').map_or(path, |(p, _)| p);
    let parts: Vec<&str> = path.split('/').collect();
    // "", "i", <instance>, "api", "v1", "files", <uuid>, <kind>
    let [_, "i", instance, "api", "v1", "files", id, kind] = parts[..] else {
        return false;
    };
    let uuid = id.len() == 36
        && id.char_indices().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        });
    if !uuid || instance.is_empty() || !instance.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    matches!(kind, "preview" | "document")
}

/// The label of the window showing `path`: `viewer-` and the first 16 hex characters of its sha256
/// (a path holds characters a label does not allow, and the hash is the same each time).
pub fn window_label(path: &str) -> String {
    let digest = Sha256::digest(path.as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("viewer-{hex}")
}

/// How often a watched file's modification time is looked at.
pub const POLL: Duration = Duration::from_secs(2);
/// How long a new content must stay the same before it counts as saved: editors write in several
/// steps (a temporary file, a rename), and offering the half-written one would send a broken version.
pub const SETTLE: Duration = Duration::from_secs(2);
/// How long a copy is watched after it was opened; after that the person opens it again.
pub const LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);
/// How many copies are watched at once, so a runaway page cannot make the app hash files forever.
pub const MAX_WATCHED: usize = 20;

fn is_id(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Where the copy of a file is kept: `<cache>/<instance>/<file id>/<name>`. The two ids come from
/// the page, so anything but letters, digits and hyphens is refused (no way to climb out of the
/// cache); the name goes through `safe_name`.
pub fn local_path(cache: &Path, instance: &str, file_id: &str, name: &str) -> Option<PathBuf> {
    if !is_id(instance) || !is_id(file_id) {
        return None;
    }
    Some(cache.join(instance).join(file_id).join(safe_name(name)))
}

/// A copy opened with the computer's app, and what is known of it.
pub struct Watched {
    pub instance: String,
    pub file_id: String,
    pub name: String,
    pub path: PathBuf,
    /// The version the copy was made from, sent back so the API can tell if the file moved on.
    pub base_version: String,
    /// The hash of the content last accepted (the downloaded one, then each one sent).
    pub hash: [u8; 32],
    pub mtime: Option<SystemTime>,
    pub since: Instant,
    /// A new content and when it was first seen, while waiting for it to stop changing.
    pub settling: Option<([u8; 32], Instant)>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Seen {
    Unchanged,
    Settling,
    Saved([u8; 32]),
    Expired,
}

/// What a look at the file means. Pure: the caller reads the file and the clock. `observed` is the
/// modification time and hash read now, or `None` when the time has not moved (no hash computed);
/// a missing file is `Unchanged` too, as an editor may have it removed for a moment while saving.
pub fn decide(w: &Watched, now: Instant, observed: Option<(SystemTime, [u8; 32])>) -> Seen {
    if now.saturating_duration_since(w.since) >= LIFETIME {
        return Seen::Expired;
    }
    let settled = |hash: [u8; 32], first_seen: Instant| {
        if now.saturating_duration_since(first_seen) >= SETTLE {
            Seen::Saved(hash)
        } else {
            Seen::Settling
        }
    };
    match observed {
        // The time did not move since the last look: only a content already waiting can finish.
        None => w.settling.map_or(Seen::Unchanged, |(h, t)| settled(h, t)),
        Some((_, hash)) if hash == w.hash => Seen::Unchanged,
        Some((_, hash)) => match w.settling {
            Some((h, t)) if h == hash => settled(hash, t),
            // A first sight, or a content that changed again: the wait starts over.
            _ => Seen::Settling,
        },
    }
}

/// The body of a `POST /api/v1/files/{id}/versions`: one `file` part. The name is quoted for a
/// header (`"` and `\` escaped, CR and LF dropped); a non-ASCII name stays UTF-8 in `filename="..."`,
/// which the API's multipart parser accepts, so no `filename*` form is needed.
pub fn multipart_file(boundary: &str, name: &str, bytes: &[u8]) -> Vec<u8> {
    let mut quoted = String::with_capacity(name.len());
    for c in name.chars() {
        match c {
            '"' | '\\' => {
                quoted.push('\\');
                quoted.push(c);
            }
            '\r' | '\n' => {}
            c => quoted.push(c),
        }
    }
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{quoted}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
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
    fn a_link_never_escapes_the_apps_origin() {
        for href in [
            "//evil.org/x",
            "/\\evil.org/x",
            "\\evil.org/x",
            "ruchoir-app://localhost//evil.org/x",
            "http://ruchoir-app.localhost//evil.org/x",
            "/a\\b",
            "ruchoir-app://localhost/a%5Cb\\c",
        ] {
            assert_eq!(own_path(href, SCHEME), None, "{href}");
        }
        assert_eq!(
            own_path("/i/x/files/a?name=b%20c&d=1", SCHEME).as_deref(),
            Some("/i/x/files/a?name=b%20c&d=1")
        );
    }

    #[test]
    fn a_title_is_cleaned_not_renamed() {
        assert_eq!(window_title("Devis: 2026?.pdf"), "Devis: 2026?.pdf");
        assert_eq!(window_title("  a\nb\u{7}c  "), "abc");
        assert_eq!(window_title("a\u{202E}b\u{2066}c\u{2069}"), "abc");
        assert_eq!(window_title(" \n "), "Ruchoir");
        let long = "é".repeat(200);
        let t = window_title(&long);
        assert_eq!(t.chars().count(), 123);
        assert!(t.ends_with("..."));
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

    #[test]
    fn only_file_bytes_open_in_a_window() {
        let id = "0b9d9c5e-5e1a-4267-85f4-bfcec5b0bd3b";
        for ok in [
            format!("/i/57268a15/api/v1/files/{id}/preview"),
            format!("/i/57268a15/api/v1/files/{id}/document?v=2026-11-03T10%3A00%3A00Z"),
            format!("/i/57268a15/api/v1/files/{id}/preview?x=1"),
        ] {
            assert!(is_file_bytes_path(&ok), "{ok}");
        }
        for bad in [
            "/".to_owned(),
            "/api/v1/files/x/preview".to_owned(),
            format!("/i/57268a15/api/v1/files/{id}/download"),
            format!("/i/57268a15/api/v1/files/{id}/preview/x"),
            format!("/i/57268a15/api/v1/files/{id}"),
            "/i/57268a15/api/v1/files/not-a-uuid/preview".to_owned(),
            "/i/57268a15/api/v1/me".to_owned(),
            format!("/i/../api/v1/files/{id}/preview"),
            format!("/i/57268a15/api/v1/files/{id}/preview/../../me"),
            "/i/57268a15/emoji/a.svg".to_owned(),
        ] {
            assert!(!is_file_bytes_path(&bad), "{bad}");
        }
    }

    fn id() -> String {
        "0b9d9c5e-5e1a-4267-85f4-bfcec5b0bd3b".to_owned()
    }

    #[test]
    fn a_local_copy_stays_in_its_instance_folder() {
        let cache = Path::new("/cache");
        let p = local_path(cache, "57268a15", &id(), "Devis.pdf").unwrap();
        assert_eq!(p, cache.join("57268a15").join(id()).join("Devis.pdf"));
        for name in ["../../etc", "C:\\x"] {
            let p = local_path(cache, "57268a15", &id(), name).unwrap();
            assert!(p.starts_with(cache.join("57268a15").join(id())), "{name}");
            assert_eq!(p.parent().unwrap(), cache.join("57268a15").join(id()));
        }
        assert_eq!(local_path(cache, "a/b", &id(), "x"), None);
        assert_eq!(local_path(cache, "..", &id(), "x"), None);
        assert_eq!(local_path(cache, "", &id(), "x"), None);
        assert_eq!(local_path(cache, "57268a15", "../x", "x"), None);
        assert_eq!(local_path(cache, "57268a15", "", "x"), None);
    }

    fn watched(now: Instant) -> Watched {
        Watched {
            instance: "57268a15".to_owned(),
            file_id: id(),
            name: "a.txt".to_owned(),
            path: PathBuf::from("/cache/a.txt"),
            base_version: "v1".to_owned(),
            hash: [1; 32],
            mtime: None,
            since: now,
            settling: None,
        }
    }

    #[test]
    fn an_untouched_file_is_unchanged() {
        let t0 = Instant::now();
        let w = watched(t0);
        assert_eq!(decide(&w, t0 + POLL, None), Seen::Unchanged);
        assert_eq!(
            decide(&w, t0 + POLL, Some((SystemTime::now(), [1; 32]))),
            Seen::Unchanged
        );
    }

    #[test]
    fn a_save_is_offered_once_it_has_settled() {
        let t0 = Instant::now();
        let mut w = watched(t0);
        let seen = Some((SystemTime::now(), [2; 32]));
        assert_eq!(decide(&w, t0 + POLL, seen), Seen::Settling);
        w.settling = Some(([2; 32], t0 + POLL));
        assert_eq!(decide(&w, t0 + POLL + SETTLE / 2, seen), Seen::Settling);
        assert_eq!(decide(&w, t0 + POLL + SETTLE, seen), Seen::Saved([2; 32]));
        // The clock may be the only thing that moved: the settled content still counts.
        assert_eq!(decide(&w, t0 + POLL + SETTLE, None), Seen::Saved([2; 32]));
    }

    #[test]
    fn a_save_still_moving_restarts_the_wait() {
        let t0 = Instant::now();
        let mut w = watched(t0);
        w.settling = Some(([2; 32], t0 + POLL));
        let later = Some((SystemTime::now(), [3; 32]));
        assert_eq!(decide(&w, t0 + POLL + SETTLE, later), Seen::Settling);
    }

    #[test]
    fn a_watch_ends_after_its_lifetime() {
        let t0 = Instant::now();
        let w = watched(t0);
        assert_eq!(decide(&w, t0 + LIFETIME, None), Seen::Expired);
        let seen = Some((SystemTime::now(), [2; 32]));
        assert_eq!(decide(&w, t0 + LIFETIME + POLL, seen), Seen::Expired);
        assert_eq!(decide(&w, t0 + LIFETIME - POLL, None), Seen::Unchanged);
    }

    #[test]
    fn a_multipart_body_carries_the_exact_bytes_and_name() {
        let bytes: Vec<u8> = (0..=255u8).chain(*b"\r\n--B--\r\n").collect();
        let body = multipart_file("B", "Devis \"é\"\\x\r\n.pdf", &bytes);
        let head = "--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"Devis \\\"é\\\"\\\\x.pdf\"\r\nContent-Type: application/octet-stream\r\n\r\n"
            .as_bytes();
        assert!(body.starts_with(head), "{}", String::from_utf8_lossy(&body));
        let tail = b"\r\n--B--\r\n";
        assert!(body.ends_with(tail));
        assert_eq!(&body[head.len()..body.len() - tail.len()], &bytes[..]);
    }
}
