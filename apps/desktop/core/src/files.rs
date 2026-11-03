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

/// The longest file name kept: 150 characters, and 200 bytes of UTF-8 (file systems such as ext4
/// cap a name at 255 bytes, and an accented name takes more bytes than characters).
const NAME_MAX: usize = 150;
const NAME_MAX_BYTES: usize = 200;

/// A file name the system will take: no folder in it, no control character, never empty, not a
/// name Windows reserves for a device (`CON`, `NUL`, `COM1`...: those open the device, whatever the
/// extension), and at most 150 characters and 200 bytes, the extension kept.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let mut cleaned = cleaned.trim().trim_matches('.').to_owned();
    if cleaned.is_empty() {
        return "download".to_owned();
    }
    let first = cleaned.split('.').next().unwrap_or("").trim_end();
    if is_reserved_stem(first) {
        cleaned.insert(0, '_');
    }
    if cleaned.chars().count() > NAME_MAX || cleaned.len() > NAME_MAX_BYTES {
        // Keep a plausible extension so the system still knows what opens the file.
        let ext = cleaned
            .rfind('.')
            .map(|i| &cleaned[i..])
            .filter(|e| e.chars().count() <= 20 && e.len() <= 60)
            .unwrap_or("");
        let mut stem = String::new();
        for c in cleaned[..cleaned.len() - ext.len()].chars() {
            if stem.chars().count() + ext.chars().count() >= NAME_MAX
                || stem.len() + ext.len() + c.len_utf8() > NAME_MAX_BYTES
            {
                break;
            }
            stem.push(c);
        }
        // Windows strips a trailing dot or space, which would change the name.
        let stem = stem.trim_end_matches(['.', ' ']);
        cleaned = if stem.is_empty() {
            format!("download{ext}")
        } else {
            format!("{stem}{ext}")
        };
    }
    cleaned
}

fn is_reserved_stem(stem: &str) -> bool {
    let up = stem.to_ascii_uppercase();
    matches!(up.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (up.len() == 4
            && (up.starts_with("COM") || up.starts_with("LPT"))
            && matches!(up.as_bytes()[3], b'1'..=b'9'))
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
    /// The version the copy was made from; the interface compares it with the file's latest version
    /// to tell whether someone added one since the download.
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

impl Watched {
    /// Records that `hash` is now the version on the instance. The caller calls it only after the
    /// upload succeeded: a dismissed or failed one leaves the base as it was, so the same content
    /// is offered again the next time it changes.
    pub fn mark_sent(&mut self, hash: [u8; 32]) {
        self.hash = hash;
        // A later save, armed while the upload ran, stays pending: only the content sent is done.
        if self.settling.is_some_and(|(h, _)| h == hash) {
            self.settling = None;
        }
    }
}

/// One look at the file, and what it means. Pure (no filesystem, no clock read): the caller reads
/// the file and the clock and passes them in, and `step` owns every update of `w` that follows.
///
/// `observed` is the modification time and hash read now, or `None` when the time has not moved
/// since the last look (no hash computed, the caller hashes only when it moved); a missing file is
/// `None` too, as an editor may remove it for a moment while saving. The time seen is recorded in
/// `w.mtime`.
///
/// - A hash different from `w.hash` arms `w.settling` (first seen now); the same one seen again
///   keeps it, a different one restarts it. Both answer `Settling`.
/// - The content going back to `w.hash` clears `w.settling` and answers `Unchanged`: an undone edit
///   is never offered.
/// - Once the pending content has stood `SETTLE` unchanged, `Saved(h)` is answered once and
///   `w.settling` is cleared. `w.hash` stays untouched: it moves only through `mark_sent`.
/// - `Expired` is answered after `LIFETIME`, but only when nothing is pending: a save in progress
///   completes first and the next look expires the watch.
pub fn step(w: &mut Watched, now: Instant, observed: Option<(SystemTime, [u8; 32])>) -> Seen {
    if let Some((mtime, _)) = observed {
        w.mtime = Some(mtime);
    }
    let differs = matches!(observed, Some((_, h)) if h != w.hash);
    if w.settling.is_none() && !differs && now.saturating_duration_since(w.since) >= LIFETIME {
        return Seen::Expired;
    }
    match observed {
        Some((_, hash)) if hash == w.hash => {
            w.settling = None;
            Seen::Unchanged
        }
        Some((_, hash)) => match w.settling {
            Some((h, t)) if h == hash => settle(w, hash, t, now),
            // A first sight, or a content that changed again: the wait starts over.
            _ => {
                w.settling = Some((hash, now));
                Seen::Settling
            }
        },
        // The time did not move: only a content already waiting can finish.
        None => match w.settling {
            Some((h, t)) => settle(w, h, t, now),
            None => Seen::Unchanged,
        },
    }
}

fn settle(w: &mut Watched, hash: [u8; 32], first_seen: Instant, now: Instant) -> Seen {
    if now.saturating_duration_since(first_seen) >= SETTLE {
        w.settling = None;
        Seen::Saved(hash)
    } else {
        Seen::Settling
    }
}

/// Whether `path` (path and query) is a link to the bytes of `file_id` on `instance`, the only kind
/// `file_open_local` accepts, so that the bytes, the instance they come from and the file the copy
/// is later sent to cannot disagree. `open_instance` is the instance on screen, which a path
/// without an instance prefix means.
pub fn is_link_to_file(
    path: &str,
    open_instance: Option<&str>,
    instance: &str,
    file_id: &str,
) -> bool {
    use crate::proxy::{route, Route};
    let bare = path.split_once('?').map_or(path, |(p, _)| p);
    let rest = match route(bare) {
        Route::Api { instance: i, rest } if i == instance => rest,
        Route::OpenApi(rest) if open_instance == Some(instance) => rest,
        _ => return false,
    };
    let parts: Vec<&str> = rest.split('/').collect();
    // "", "api", "v1", "files", <id>, <kind>
    let [_, "api", "v1", "files", id, kind] = parts[..] else {
        return false;
    };
    id == file_id && is_id(id) && matches!(kind, "download" | "preview" | "document")
}

/// Extensions the system would run rather than show: a file of one of these types is never opened
/// from the app (it is still saved with "Save as", where the person chooses).
const EXECUTABLE: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "msi",
    "msp",
    "scr",
    "pif",
    "cpl",
    "ps1",
    "psm1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "hta",
    "jar",
    "lnk",
    "url",
    "reg",
    "sh",
    "bash",
    "zsh",
    "command",
    "desktop",
    "app",
    "appimage",
    "run",
    "deb",
    "rpm",
    "pkg",
    "dmg",
    "xll",
    "wll",
    "jnlp",
    "scf",
    "chm",
    "msc",
    "inf",
    "ws",
    "wsc",
    "vb",
    "py",
    "pyw",
    "pl",
    "ps1xml",
    "appref-ms",
    "application",
    "msix",
    "appx",
    "msixbundle",
    "appxbundle",
    "scpt",
    "workflow",
    "terminal",
    "action",
    "csh",
    "ksh",
    "fish",
    "gadget",
    "mde",
];

/// Whether the file name ends in an extension that would be executed (case-insensitive; trailing
/// dots and spaces are ignored, as Windows does).
pub fn is_executable_type(name: &str) -> bool {
    let name = name.trim_end_matches(['.', ' ']);
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| EXECUTABLE.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Whether a file of this name must not be opened from the app: its name as given, or as it will be
/// kept (`safe_name` can cut a long name so that an earlier `.exe` becomes the extension).
pub fn is_unsafe_to_open(name: &str) -> bool {
    is_executable_type(name) || is_executable_type(&safe_name(name))
}

/// The SHA-256 of a file, read in pieces (a large file is never held whole in memory).
pub fn hash_file(path: &Path) -> std::io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    std::io::copy(&mut std::fs::File::open(path)?, &mut hasher)?;
    Ok(hasher.finalize().into())
}

/// How a session ended, for what becomes of the opened copies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionEnd {
    /// The server refused the token (a 401): the person signs in again and carries on.
    Expired,
    /// The person signed out or removed the instance.
    Deliberate,
}

impl SessionEnd {
    /// An expired session keeps the watches and the copies, so the edited file is still there to
    /// send or keep once the person signs in again; only a deliberate end deletes them.
    pub fn keeps_copies(self) -> bool {
        self == SessionEnd::Expired
    }
}

/// The SHA-256 of a content, as `step` and `mark_sent` compare it.
pub fn hash_bytes(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// The copies being watched, at most `MAX_WATCHED`. A copy is told apart by its instance and file
/// id; opening the same file again replaces the earlier entry, and a 21st file evicts the oldest.
#[derive(Default)]
pub struct Watches {
    list: Vec<Watched>,
}

impl Watches {
    /// Adds `w`, replacing an entry for the same file, and returns the entry pushed out to make
    /// room (the one opened longest ago) when the list was full.
    pub fn insert(&mut self, w: Watched) -> Option<Watched> {
        self.list
            .retain(|e| !(e.instance == w.instance && e.file_id == w.file_id));
        let evicted = if self.list.len() >= MAX_WATCHED {
            let oldest = (0..self.list.len()).min_by_key(|&i| self.list[i].since)?;
            Some(self.list.remove(oldest))
        } else {
            None
        };
        self.list.push(w);
        evicted
    }

    pub fn find(&mut self, instance: &str, file_id: &str) -> Option<&mut Watched> {
        self.list
            .iter_mut()
            .find(|e| e.instance == instance && e.file_id == file_id)
    }

    pub fn remove(&mut self, instance: &str, file_id: &str) -> Option<Watched> {
        let at = self
            .list
            .iter()
            .position(|e| e.instance == instance && e.file_id == file_id)?;
        Some(self.list.remove(at))
    }

    /// Stops every watch of an instance (its sign-out or removal).
    pub fn forget_instance(&mut self, instance: &str) {
        self.list.retain(|e| e.instance != instance);
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    /// What the polling task needs to look at: instance, file id, path and the last time seen.
    pub fn snapshot(&self) -> Vec<(String, String, PathBuf, Option<SystemTime>)> {
        self.list
            .iter()
            .map(|e| {
                (
                    e.instance.clone(),
                    e.file_id.clone(),
                    e.path.clone(),
                    e.mtime,
                )
            })
            .collect()
    }
}

/// The folder holding every opened copy: `<cache>/open`.
pub fn open_root(cache: &Path) -> PathBuf {
    cache.join("open")
}

/// Deletes an instance's opened copies (`<open root>/<instance>`). An id with anything but letters,
/// digits and hyphens is ignored, so it cannot name a folder outside the root.
pub fn forget_instance_copies(root: &Path, instance: &str) {
    if is_id(instance) {
        let _ = std::fs::remove_dir_all(root.join(instance));
    }
}

/// Deletes the opened copies left untouched for `max_age` (a file's folder is judged by the newest
/// of its own time and its content's, so a file the person kept saving stays), and the instance
/// folders that end up empty. Returns how many file folders went. Run at launch: the watches are
/// in memory only, so a copy that old is no longer watched anyway.
pub fn sweep_old_copies(root: &Path, now: SystemTime, max_age: Duration) -> usize {
    let mut removed = 0;
    let Ok(instances) = std::fs::read_dir(root) else {
        return 0;
    };
    for instance in instances.flatten() {
        let path = instance.path();
        let Ok(files) = std::fs::read_dir(&path) else {
            // A stray file at this level has no place here.
            let _ = std::fs::remove_file(&path);
            continue;
        };
        for file in files.flatten() {
            let folder = file.path();
            if now.duration_since(newest_time(&folder)).unwrap_or_default() >= max_age
                && std::fs::remove_dir_all(&folder).is_ok()
            {
                removed += 1;
            }
        }
        // Only succeeds when empty.
        let _ = std::fs::remove_dir(&path);
    }
    removed
}

fn newest_time(folder: &Path) -> SystemTime {
    let time = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let mut newest = time(folder).unwrap_or(SystemTime::UNIX_EPOCH);
    if let Ok(entries) = std::fs::read_dir(folder) {
        for entry in entries.flatten() {
            if let Some(t) = time(&entry.path()) {
                newest = newest.max(t);
            }
        }
    }
    newest
}

/// The body of a `POST /api/v1/files/{id}/versions`: one `file` part. `boundary` must be a
/// generated token (no CR, LF or `--`, never empty), so it cannot occur in the framing by chance.
/// The name is quoted for a header (`"` and `\` escaped, control characters dropped); a non-ASCII
/// name stays UTF-8 in `filename="..."`, which the API's multipart parser accepts, so no
/// `filename*` form is needed.
pub fn multipart_file(boundary: &str, name: &str, bytes: &[u8]) -> Vec<u8> {
    debug_assert!(!boundary.is_empty() && !boundary.contains(['\r', '\n']));
    debug_assert!(!boundary.contains("--"));
    let mut quoted = String::with_capacity(name.len());
    for c in name.chars() {
        match c {
            '"' | '\\' => {
                quoted.push('\\');
                quoted.push(c);
            }
            c if c.is_control() => {}
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
    fn a_name_is_no_device_and_not_too_long() {
        for (name, want) in [
            ("CON", "_CON"),
            ("nul.txt", "_nul.txt"),
            ("Com1.tar.gz", "_Com1.tar.gz"),
            ("LPT9.pdf", "_LPT9.pdf"),
            ("COM0.txt", "COM0.txt"),
            ("CONSOLE.txt", "CONSOLE.txt"),
            ("communion.txt", "communion.txt"),
        ] {
            assert_eq!(safe_name(name), want);
        }
        let long = format!("{}.docx", "é".repeat(300));
        let n = safe_name(&long);
        assert!(n.len() <= 200 && n.len() >= 198);
        assert!(n.ends_with(".docx"));
        // 150 accented characters are 300 bytes: the byte cap bites first, on a character boundary.
        let acc = safe_name(&format!("{}.pdf", "é".repeat(150)));
        assert!(acc.len() <= 200 && acc.ends_with(".pdf"));
        assert!(acc.starts_with('é'));
        // A cut never leaves a trailing dot or space (Windows would strip it).
        let cut = safe_name(&format!("{}. {}", "a".repeat(143), "b".repeat(20)));
        assert!(!cut.ends_with(['.', ' ']), "{cut}");
        let cut = safe_name(&format!("{} .pdf{}", "a".repeat(145), "x".repeat(10)));
        assert!(!cut.contains(" ."), "{cut}");
        let no_ext = safe_name(&"a".repeat(300));
        assert_eq!(no_ext.chars().count(), 150);
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
        let p = local_path(cache, "57268a15", &id(), "Relevé été/2026 final.pdf").unwrap();
        assert_eq!(p.file_name().unwrap(), "Relevé été_2026 final.pdf");
        assert_eq!(p.parent().unwrap(), cache.join("57268a15").join(id()));
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

    fn seen(h: u8) -> Option<(SystemTime, [u8; 32])> {
        Some((SystemTime::now(), [h; 32]))
    }

    #[test]
    fn an_untouched_file_is_unchanged() {
        let t0 = Instant::now();
        let mut w = watched(t0);
        assert_eq!(step(&mut w, t0 + POLL, None), Seen::Unchanged);
        assert_eq!(step(&mut w, t0 + POLL, seen(1)), Seen::Unchanged);
        assert!(w.mtime.is_some());
    }

    #[test]
    fn a_save_is_offered_once_it_has_settled() {
        let t0 = Instant::now();
        let mut w = watched(t0);
        assert_eq!(step(&mut w, t0 + POLL, seen(2)), Seen::Settling);
        assert_eq!(w.settling.map(|s| s.0), Some([2; 32]));
        assert_eq!(step(&mut w, t0 + POLL + SETTLE / 2, None), Seen::Settling);
        assert_eq!(step(&mut w, t0 + POLL + SETTLE, None), Seen::Saved([2; 32]));
        // Reported once, and the base moves only when the upload succeeded.
        assert_eq!(w.settling, None);
        assert_eq!(w.hash, [1; 32]);
        assert_eq!(
            step(&mut w, t0 + POLL + SETTLE + POLL, None),
            Seen::Unchanged
        );
        w.mark_sent([2; 32]);
        assert_eq!(w.hash, [2; 32]);
        assert_eq!(
            step(&mut w, t0 + POLL + SETTLE + POLL, seen(2)),
            Seen::Unchanged
        );
    }

    #[test]
    fn a_later_save_survives_the_end_of_an_upload() {
        let t0 = Instant::now();
        let mut w = watched(t0);
        assert_eq!(step(&mut w, t0, seen(3)), Seen::Settling);
        w.mark_sent([2; 32]);
        assert_eq!(w.hash, [2; 32]);
        assert_eq!(step(&mut w, t0 + SETTLE, None), Seen::Saved([3; 32]));
    }

    #[test]
    fn a_save_still_moving_restarts_the_wait() {
        // The Word double save: h2 is written, then h3 within SETTLE.
        let t0 = Instant::now();
        let mut w = watched(t0);
        assert_eq!(step(&mut w, t0, seen(2)), Seen::Settling);
        assert_eq!(step(&mut w, t0 + SETTLE / 2, seen(3)), Seen::Settling);
        assert_eq!(step(&mut w, t0 + SETTLE, None), Seen::Settling);
        assert_eq!(
            step(&mut w, t0 + SETTLE / 2 + SETTLE, None),
            Seen::Saved([3; 32])
        );
        assert_eq!(step(&mut w, t0 + 3 * SETTLE, None), Seen::Unchanged);
    }

    #[test]
    fn an_undone_edit_is_never_offered() {
        let t0 = Instant::now();
        let mut w = watched(t0);
        assert_eq!(step(&mut w, t0, seen(2)), Seen::Settling);
        assert_eq!(step(&mut w, t0 + POLL, seen(1)), Seen::Unchanged);
        assert_eq!(w.settling, None);
        assert_eq!(step(&mut w, t0 + POLL + SETTLE, None), Seen::Unchanged);
    }

    #[test]
    fn a_watch_ends_after_its_lifetime_once_nothing_is_pending() {
        let t0 = Instant::now();
        let mut w = watched(t0);
        assert_eq!(step(&mut w, t0 + LIFETIME - POLL, None), Seen::Unchanged);
        assert_eq!(step(&mut w, t0 + LIFETIME, None), Seen::Expired);
        assert_eq!(step(&mut w, t0 + LIFETIME, seen(1)), Seen::Expired);
        // A save in progress completes first, then the next look expires the watch.
        let mut w = watched(t0);
        let late = t0 + LIFETIME;
        assert_eq!(step(&mut w, late, seen(2)), Seen::Settling);
        assert_eq!(step(&mut w, late + SETTLE, None), Seen::Saved([2; 32]));
        assert_eq!(step(&mut w, late + SETTLE + POLL, None), Seen::Expired);
    }

    #[test]
    fn a_multipart_body_carries_the_exact_bytes_and_name() {
        let bytes: Vec<u8> = (0..=255u8).chain(*b"\r\n--B--\r\n").collect();
        let body = multipart_file("B", "Devis \"é\"\\x\r\n\0.pdf", &bytes);
        let head = "--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"Devis \\\"é\\\"\\\\x.pdf\"\r\nContent-Type: application/octet-stream\r\n\r\n"
            .as_bytes();
        assert!(body.starts_with(head), "{}", String::from_utf8_lossy(&body));
        let tail = b"\r\n--B--\r\n";
        assert!(body.ends_with(tail));
        assert_eq!(&body[head.len()..body.len() - tail.len()], &bytes[..]);
    }

    fn entry(instance: &str, file: &str, since: Instant) -> Watched {
        Watched {
            instance: instance.into(),
            file_id: file.into(),
            name: "a.docx".into(),
            path: PathBuf::from("/x/a.docx"),
            base_version: "v1".into(),
            hash: [0; 32],
            mtime: None,
            since,
            settling: None,
        }
    }

    #[test]
    fn a_21st_watch_evicts_the_oldest() {
        let mut w = Watches::default();
        let start = Instant::now();
        for i in 0..MAX_WATCHED {
            let at = start + Duration::from_secs(i as u64);
            assert!(w.insert(entry("i", &format!("f{i}"), at)).is_none());
        }
        let out = w
            .insert(entry("i", "new", start + Duration::from_secs(99)))
            .expect("the list was full");
        assert_eq!(out.file_id, "f0");
        assert_eq!(w.len(), MAX_WATCHED);
        assert!(w.find("i", "f0").is_none());
        assert!(w.find("i", "new").is_some());
    }

    #[test]
    fn opening_a_file_again_replaces_its_entry() {
        let mut w = Watches::default();
        let now = Instant::now();
        w.insert(entry("i", "f", now));
        assert!(w.insert(entry("i", "f", now)).is_none());
        assert_eq!(w.len(), 1);
        w.insert(entry("j", "f", now));
        assert_eq!(w.len(), 2);
    }

    #[test]
    fn forgetting_an_instance_drops_its_watches_and_copies() {
        let mut w = Watches::default();
        let now = Instant::now();
        w.insert(entry("a", "f1", now));
        w.insert(entry("a", "f2", now));
        w.insert(entry("b", "f1", now));
        w.forget_instance("a");
        assert_eq!(w.len(), 1);
        assert!(w.find("b", "f1").is_some());

        let dir = tempfile::tempdir().unwrap();
        let root = open_root(dir.path());
        for instance in ["a", "b"] {
            let p = local_path(&root, instance, "f1", "x.docx").unwrap();
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"x").unwrap();
        }
        forget_instance_copies(&root, "a");
        forget_instance_copies(&root, "../b");
        assert!(!root.join("a").exists());
        assert!(root.join("b").exists());
    }

    #[test]
    fn the_launch_sweep_keeps_new_copies_and_drops_old_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = open_root(dir.path());
        let make = |instance: &str, file: &str, age: Duration| {
            let p = local_path(&root, instance, file, "x.docx").unwrap();
            let folder = p.parent().unwrap().to_owned();
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(&p, b"x").unwrap();
            let then = SystemTime::now() - age;
            std::fs::File::options()
                .write(true)
                .open(&p)
                .unwrap()
                .set_modified(then)
                .unwrap();
            std::fs::File::open(&folder)
                .unwrap()
                .set_modified(then)
                .unwrap();
        };
        let day = Duration::from_secs(24 * 3600);
        make("a", "old", day * 2);
        make("a", "fresh", Duration::from_secs(3600));
        make("b", "old", day * 3);
        let removed = sweep_old_copies(&root, SystemTime::now(), day);
        assert_eq!(removed, 2);
        assert!(root.join("a/fresh").exists());
        assert!(!root.join("a/old").exists());
        assert!(
            !root.join("b").exists(),
            "an emptied instance folder goes too"
        );
        assert_eq!(
            sweep_old_copies(&dir.path().join("none"), SystemTime::now(), day),
            0
        );
    }

    #[test]
    fn only_the_files_own_bytes_link_matches() {
        let id = "0b1f6a52-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
        let other = "1b1f6a52-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
        let mine = format!("/i/a1/api/v1/files/{id}/download");
        assert!(is_link_to_file(&mine, None, "a1", id));
        assert!(is_link_to_file(&format!("{mine}?x=1"), None, "a1", id));
        assert!(!is_link_to_file(&mine, None, "b2", id));
        assert!(!is_link_to_file(&mine, None, "a1", other));
        let bare = format!("/api/v1/files/{id}/download");
        assert!(is_link_to_file(&bare, Some("a1"), "a1", id));
        assert!(!is_link_to_file(&bare, Some("b2"), "a1", id));
        assert!(!is_link_to_file(&bare, None, "a1", id));
        assert!(!is_link_to_file(
            &format!("/api/v1/files/{id}/versions"),
            Some("a1"),
            "a1",
            id
        ));
        assert!(!is_link_to_file(
            &format!("/api/v1/files/{id}/download/x"),
            Some("a1"),
            "a1",
            id
        ));
        assert!(!is_link_to_file("/emoji/x", Some("a1"), "a1", id));
    }

    #[test]
    fn what_the_system_would_run_is_not_opened() {
        for n in [
            "a.exe",
            "A.EXE",
            "x.Bat",
            "run.sh",
            "a.b.ps1",
            "setup.msi.",
            "k.AppImage",
            "x.desktop",
            "x.js",
        ] {
            assert!(is_executable_type(n), "{n}");
        }
        for n in [
            "a.docx",
            "photo.png",
            "exe",
            "notes.txt",
            "archive.exe.txt",
            "js",
            ".bashrc",
        ] {
            assert!(!is_executable_type(n), "{n}");
        }
    }

    #[test]
    fn a_cut_name_is_checked_as_it_will_be_kept() {
        let name = format!("{}.exe.{}", "a".repeat(146), "b".repeat(25));
        assert!(!is_executable_type(&name));
        assert!(safe_name(&name).ends_with(".exe"));
        assert!(is_unsafe_to_open(&name));
        assert!(!is_unsafe_to_open("report.docx"));
        for n in ["a.xll", "a.PY", "a.appref-ms", "a.fish", "a.msix", "a.jnlp"] {
            assert!(is_executable_type(n), "{n}");
        }
        assert!(!is_executable_type("a.mdb"));
    }

    #[test]
    fn an_expired_session_keeps_the_copies_and_a_deliberate_end_does_not() {
        assert!(SessionEnd::Expired.keeps_copies());
        assert!(!SessionEnd::Deliberate.keeps_copies());
    }

    #[test]
    fn a_file_is_hashed_like_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f");
        let big = vec![7u8; 300_000];
        std::fs::write(&p, &big).unwrap();
        assert_eq!(hash_file(&p).unwrap(), hash_bytes(&big));
        assert!(hash_file(&dir.path().join("none")).is_err());
    }
}
