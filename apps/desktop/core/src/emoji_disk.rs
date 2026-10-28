//! The emoji pack's files kept on disk between launches. The memory cache (`proxy::EmojiCache`)
//! lasts one run; without this, every launch fetched the 5 MB sprite again before the picker could
//! draw. A file is trusted for a week, the instance's own `max-age` for the pack, then fetched again.
//! Only plain pack paths are kept (`/emoji/sprite.svg`, `/emoji/animated/1f600.png`): nothing with a
//! query, nothing that could name a file outside the folder.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use reqwest::header::{HeaderMap, HeaderValue, CACHE_CONTROL, CONTENT_TYPE};

use crate::proxy::Answer;

/// How long a kept file stands for the instance's answer.
pub const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);

/// Where `path` (`/emoji/...`) is kept under `dir`; `None` for a path that is not kept.
pub fn file_for(dir: &Path, path: &str) -> Option<PathBuf> {
    let rest = path.strip_prefix("/emoji/")?;
    let plain = !rest.is_empty()
        && rest.len() <= 128
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
        && rest
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    plain.then(|| dir.join(rest.replace('/', "__")))
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("svg") => "image/svg+xml",
        Some("json") => "application/json",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    }
}

/// The kept answer for `path`, when there is one younger than `max_age`.
pub fn read(dir: &Path, path: &str, max_age: Duration) -> Option<Answer> {
    let file = file_for(dir, path)?;
    let age = std::fs::metadata(&file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|at| SystemTime::now().duration_since(at).ok())?;
    if age >= max_age {
        return None;
    }
    let body = std::fs::read(&file).ok()?;
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type(&file)));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    Some(Answer {
        status: 200,
        headers,
        body,
    })
}

/// Keep a successful answer for `path`; written aside first, so a reader never sees half a file.
pub fn write(dir: &Path, path: &str, answer: &Answer) {
    if answer.status != 200 {
        return;
    }
    let Some(file) = file_for(dir, path) else {
        return;
    };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let aside = file.with_extension("part");
    if std::fs::write(&aside, &answer.body).is_ok() && std::fs::rename(&aside, &file).is_err() {
        let _ = std::fs::remove_file(&aside);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(body: &[u8]) -> Answer {
        Answer {
            status: 200,
            headers: HeaderMap::new(),
            body: body.to_vec(),
        }
    }

    #[test]
    fn only_plain_pack_paths_are_kept() {
        let dir = Path::new("/cache/emoji");
        assert_eq!(
            file_for(dir, "/emoji/sprite.svg"),
            Some(dir.join("sprite.svg"))
        );
        assert_eq!(
            file_for(dir, "/emoji/animated/1f600.png"),
            Some(dir.join("animated__1f600.png"))
        );
        assert_eq!(file_for(dir, "/emoji/manifest.json?v=2"), None);
        assert_eq!(file_for(dir, "/emoji/../secret"), None);
        assert_eq!(file_for(dir, "/emoji//x"), None);
        assert_eq!(file_for(dir, "/emoji/"), None);
        assert_eq!(file_for(dir, "/api/v1/me"), None);
    }

    #[test]
    fn a_kept_file_answers_until_it_is_too_old() {
        let dir = tempfile::tempdir().expect("folder");
        assert!(read(dir.path(), "/emoji/sprite.svg", MAX_AGE).is_none());
        write(dir.path(), "/emoji/sprite.svg", &ok(b"<svg/>"));
        let kept = read(dir.path(), "/emoji/sprite.svg", MAX_AGE).expect("kept");
        assert_eq!(kept.body, b"<svg/>");
        assert_eq!(kept.headers[CONTENT_TYPE], "image/svg+xml");
        assert!(read(dir.path(), "/emoji/sprite.svg", Duration::ZERO).is_none());
    }

    #[test]
    fn a_failure_is_never_kept() {
        let dir = tempfile::tempdir().expect("folder");
        let mut failed = ok(b"gone");
        failed.status = 404;
        write(dir.path(), "/emoji/sprite.svg", &failed);
        assert!(read(dir.path(), "/emoji/sprite.svg", MAX_AGE).is_none());
    }
}
