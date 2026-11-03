//! The account preferences document: a flat JSON object of known keys.
//!
//! A client sends only the keys it changed (`PATCH`), and a key set to `null` goes back to its
//! default. Every key is checked against the closed list below: an unknown key or a value out of
//! range refuses the whole change, so a client never believes something was kept when it was not.
//!
//! The list is flat on purpose. The phone knows two of the calendar's settings; if the calendar were
//! one object, the phone patching it would erase the nine others the web keeps.
//!
//! Stored in `user_preferences`: `font` and `emoji_animated` in their typed columns, which existed
//! before this document, and the rest as JSON text in `ui_state` ([`split`] and [`join`]).

use serde_json::{Map, Value};
use uuid::Uuid;

/// A preferences document, or a change to one: wire keys to values.
pub type Document = Map<String, Value>;

/// The largest `ui_state` the server keeps, serialised. Far above what the known keys can reach in
/// honest use; it only stops the document from becoming storage.
pub const MAX_UI_STATE_BYTES: usize = 16 * 1024;

const FONTS: &[&str] = &["plex", "system", "dyslexic"];
const LOCALES: &[&str] = &["fr", "en", "es", "de", "it", "pl"];
const FILES_LAYOUTS: &[&str] = &["list", "grid"];
const DEFAULT_PANELS: &[&str] = &["members", "files", "pinned", "none"];
const AGENDA_VIEWS: &[&str] = &["list", "week", "month", "year"];
const DESKTOP_VIEWS: &[&str] = &["month", "week", "day", "list"];
const PHONE_VIEWS: &[&str] = &["list", "day", "month"];
const CLOCKS: &[&str] = &["auto", "24", "12"];
const WEEK_STARTS: &[i64] = &[0, 1, 6];
const DURATIONS: &[i64] = &[15, 30, 45, 60, 90, 120];

/// Every key the document may hold, in the order of the spec's table.
pub const KEYS: &[&str] = &[
    "font",
    "emoji_animated",
    "locale",
    "space_order",
    "collapsed_sections",
    "shortcuts",
    "welcome",
    "files_layout",
    "default_panel",
    "external_link_warning",
    "agenda_view",
    "calendar_view_desktop",
    "calendar_view_phone",
    "calendar_week_start",
    "calendar_clock",
    "calendar_weekends",
    "calendar_week_numbers",
    "calendar_open_at",
    "calendar_work_hours",
    "calendar_work_start",
    "calendar_work_end",
    "calendar_duration",
];

/// The working day the apps show when nobody chose one (`DEFAULT_CALENDAR_PREFS` on the web).
const DEFAULT_WORK_START: i64 = 9;
const DEFAULT_WORK_END: i64 = 18;

const MAX_SPACE_ORDER: usize = 500;
const MAX_COLLAPSED_SECTIONS: usize = 16;
const MAX_SHORTCUTS: usize = 64;
const MAX_CHORD_CHARS: usize = 64;
const MAX_WELCOME_STEPS: usize = 32;

/// Whether `value` is made of `[A-Za-z0-9._-]` (plus `:` when `colon`), between 1 and `max` chars.
fn is_token(value: &str, max: usize, colon: bool) -> bool {
    (1..=max).contains(&value.len())
        && value.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') || (colon && c == ':')
        })
}

fn one_of(value: &Value, allowed: &[&str]) -> Result<(), String> {
    match value.as_str() {
        Some(s) if allowed.contains(&s) => Ok(()),
        _ => Err(format!("expected one of {}", allowed.join(", "))),
    }
}

fn int_in(value: &Value, allowed: impl Fn(i64) -> bool, what: &str) -> Result<(), String> {
    match value.as_i64() {
        Some(n) if allowed(n) => Ok(()),
        _ => Err(format!("expected {what}")),
    }
}

fn boolean(value: &Value) -> Result<(), String> {
    if value.is_boolean() {
        Ok(())
    } else {
        Err("expected true or false".to_owned())
    }
}

fn list_of(value: &Value, max: usize) -> Result<&Vec<Value>, String> {
    match value.as_array() {
        Some(items) if items.len() <= max => Ok(items),
        Some(_) => Err(format!("at most {max} entries")),
        None => Err("expected a list".to_owned()),
    }
}

fn token_list(value: &Value, max: usize, chars: usize, colon: bool) -> Result<(), String> {
    for item in list_of(value, max)? {
        match item.as_str() {
            Some(s) if is_token(s, chars, colon) => {}
            _ => return Err("an entry is not a valid id".to_owned()),
        }
    }
    Ok(())
}

fn space_order(value: &Value) -> Result<(), String> {
    for item in list_of(value, MAX_SPACE_ORDER)? {
        if item
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok())
            .is_none()
        {
            return Err("an entry is not a space id".to_owned());
        }
    }
    Ok(())
}

fn shortcuts(value: &Value) -> Result<(), String> {
    let Some(map) = value.as_object() else {
        return Err("expected an object".to_owned());
    };
    if map.len() > MAX_SHORTCUTS {
        return Err(format!("at most {MAX_SHORTCUTS} entries"));
    }
    for (command, chord) in map {
        if !is_token(command, 64, false) {
            return Err("a command id is not valid".to_owned());
        }
        match chord.as_str() {
            // `""` is a command left without a key, which is a choice.
            Some(s) if s.chars().count() <= MAX_CHORD_CHARS => {}
            _ => {
                return Err(format!(
                    "a binding is not a string of at most {MAX_CHORD_CHARS} characters"
                ))
            }
        }
    }
    Ok(())
}

fn welcome(value: &Value) -> Result<(), String> {
    let Some(map) = value.as_object() else {
        return Err("expected an object".to_owned());
    };
    for (field, inner) in map {
        match field.as_str() {
            "dismissed" => boolean(inner)?,
            "done" => token_list(inner, MAX_WELCOME_STEPS, 64, false)?,
            _ => return Err(format!("unknown field {field}")),
        }
    }
    Ok(())
}

/// Check one key and its (non-null) value.
fn check(key: &str, value: &Value) -> Result<(), String> {
    match key {
        "font" => one_of(value, FONTS),
        "emoji_animated"
        | "external_link_warning"
        | "calendar_weekends"
        | "calendar_week_numbers"
        | "calendar_work_hours" => boolean(value),
        "locale" => one_of(value, LOCALES),
        "space_order" => space_order(value),
        "collapsed_sections" => token_list(value, MAX_COLLAPSED_SECTIONS, 80, true),
        "shortcuts" => shortcuts(value),
        "welcome" => welcome(value),
        "files_layout" => one_of(value, FILES_LAYOUTS),
        "default_panel" => one_of(value, DEFAULT_PANELS),
        "agenda_view" => one_of(value, AGENDA_VIEWS),
        "calendar_view_desktop" => one_of(value, DESKTOP_VIEWS),
        "calendar_view_phone" => one_of(value, PHONE_VIEWS),
        "calendar_clock" => one_of(value, CLOCKS),
        "calendar_week_start" => int_in(value, |n| WEEK_STARTS.contains(&n), "0, 1 or 6"),
        "calendar_open_at" | "calendar_work_start" => {
            int_in(value, |n| (0..=23).contains(&n), "an hour from 0 to 23")
        }
        "calendar_work_end" => int_in(value, |n| (0..=24).contains(&n), "an hour from 0 to 24"),
        "calendar_duration" => int_in(
            value,
            |n| DURATIONS.contains(&n),
            "15, 30, 45, 60, 90 or 120",
        ),
        _ => Err("unknown preference".to_owned()),
    }
}

/// Check a change: every key known, every value it sets valid. `null` (back to the default) is
/// always accepted for a known key. The error reads `"<key>: <reason>"`.
pub fn validate_patch(patch: &Document) -> Result<(), String> {
    for (key, value) in patch {
        let checked = if !KEYS.contains(&key.as_str()) {
            Err("unknown preference".to_owned())
        } else if value.is_null() {
            Ok(())
        } else {
            check(key, value)
        };
        checked.map_err(|reason| format!("{key}: {reason}"))?;
    }
    Ok(())
}

/// Apply `patch` (already validated) to `stored`: the keys it names replace theirs, `null` removes
/// one, the others are untouched. Then the rules that span keys, and the size bound.
pub fn merge(stored: &Document, patch: &Document) -> Result<Document, String> {
    let mut out = stored.clone();
    for (key, value) in patch {
        if value.is_null() {
            out.remove(key);
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    // An end nobody set is the default one, for every app: a start after it is as wrong as after a
    // stored end, or the apps would each show something else.
    let start = out.get("calendar_work_start").and_then(Value::as_i64);
    let end = out.get("calendar_work_end").and_then(Value::as_i64);
    if (start.is_some() || end.is_some())
        && start.unwrap_or(DEFAULT_WORK_START) >= end.unwrap_or(DEFAULT_WORK_END)
    {
        return Err("calendar_work_start: the working day must start before it ends".to_owned());
    }
    let (_, _, rest) = split(&out);
    if Value::Object(rest).to_string().len() > MAX_UI_STATE_BYTES {
        return Err(format!(
            "preferences: larger than {MAX_UI_STATE_BYTES} bytes"
        ));
    }
    Ok(out)
}

/// A document as stored: the font, the emoji animation, and the rest for `ui_state`.
pub fn split(doc: &Document) -> (Option<String>, Option<bool>, Document) {
    let mut rest = doc.clone();
    let font = rest
        .remove("font")
        .and_then(|v| v.as_str().map(str::to_owned));
    let emoji_animated = rest.remove("emoji_animated").and_then(|v| v.as_bool());
    (font, emoji_animated, rest)
}

/// A document read back from its columns. An unreadable `ui_state` reads as empty, and a key that
/// is no longer known, or whose value no longer passes, is left out rather than served.
pub fn join(
    font: Option<String>,
    emoji_animated: Option<bool>,
    ui_state: Option<&str>,
) -> Document {
    let mut doc: Document = ui_state
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|v| match v {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();
    doc.retain(|key, value| key != "font" && key != "emoji_animated" && check(key, value).is_ok());
    if let Some(font) = font.filter(|f| FONTS.contains(&f.as_str())) {
        doc.insert("font".to_owned(), Value::String(font));
    }
    if let Some(animated) = emoji_animated {
        doc.insert("emoji_animated".to_owned(), Value::Bool(animated));
    }
    doc
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(value: Value) -> Document {
        value.as_object().expect("object").clone()
    }

    #[test]
    fn accepts_every_known_key_with_a_valid_value() {
        let patch = doc(json!({
            "font": "dyslexic",
            "emoji_animated": false,
            "locale": "en",
            "space_order": [Uuid::new_v4().to_string()],
            "collapsed_sections": ["favourites", "messages"],
            "shortcuts": { "search": "Mod+K", "editLast": "ArrowUp", "help": "" },
            "welcome": { "dismissed": true, "done": ["profile", "channel"] },
            "files_layout": "grid",
            "default_panel": "none",
            "external_link_warning": false,
            "agenda_view": "year",
            "calendar_view_desktop": "month",
            "calendar_view_phone": "day",
            "calendar_week_start": 0,
            "calendar_clock": "24",
            "calendar_weekends": false,
            "calendar_week_numbers": true,
            "calendar_open_at": 7,
            "calendar_work_hours": true,
            "calendar_work_start": 8,
            "calendar_work_end": 24,
            "calendar_duration": 90
        }));
        assert_eq!(validate_patch(&patch), Ok(()));
    }

    #[test]
    fn refuses_an_unknown_key() {
        // The theme is the device's: the server does not keep it.
        let err = validate_patch(&doc(json!({ "theme": "sky" }))).unwrap_err();
        assert!(err.starts_with("theme:"), "{err}");
        let err = validate_patch(&doc(json!({ "theme": null }))).unwrap_err();
        assert!(err.starts_with("theme:"), "{err}");
    }

    #[test]
    fn refuses_a_value_out_of_range() {
        let too_many: Vec<String> = (0..501).map(|_| Uuid::new_v4().to_string()).collect();
        for (key, value) in [
            ("calendar_open_at", json!(24)),
            ("calendar_duration", json!(20)),
            ("calendar_week_start", json!(2)),
            ("locale", json!("xx")),
            ("font", json!(3)),
            ("space_order", json!(too_many)),
            ("space_order", json!(["not-a-uuid"])),
            ("collapsed_sections", json!(["has space"])),
            ("shortcuts", json!({ "search": 5 })),
            ("welcome", json!({ "done": "profile" })),
            ("welcome", json!({ "other": true })),
        ] {
            let mut patch = Document::new();
            patch.insert(key.to_owned(), value);
            let err = validate_patch(&patch).unwrap_err();
            assert!(err.starts_with(&format!("{key}:")), "{key}: {err}");
        }
    }

    #[test]
    fn null_removes_a_key() {
        let stored = doc(json!({ "locale": "en", "font": "system" }));
        let patch = doc(json!({ "locale": null }));
        assert_eq!(validate_patch(&patch), Ok(()));
        assert_eq!(merge(&stored, &patch), Ok(doc(json!({ "font": "system" }))));
    }

    #[test]
    fn merge_keeps_keys_it_does_not_name() {
        let order = json!([Uuid::new_v4().to_string()]);
        let stored = doc(json!({ "space_order": order, "shortcuts": { "search": "Mod+K" } }));
        let merged = merge(&stored, &doc(json!({ "locale": "de" }))).expect("merged");
        assert_eq!(merged["space_order"], order);
        assert_eq!(merged["shortcuts"]["search"], "Mod+K");
        assert_eq!(merged["locale"], "de");
    }

    #[test]
    fn merge_refuses_work_start_after_work_end() {
        let stored = doc(json!({ "calendar_work_end": 18 }));
        let err = merge(&stored, &doc(json!({ "calendar_work_start": 20 }))).unwrap_err();
        assert!(err.starts_with("calendar_work_start:"), "{err}");
        assert!(merge(&stored, &doc(json!({ "calendar_work_start": 17 }))).is_ok());
    }

    #[test]
    fn the_working_day_is_checked_against_the_default_of_the_other_end() {
        // Nobody set the end (the phone never touches it): it is the default 18 h for every app.
        let err = merge(&Document::new(), &doc(json!({ "calendar_work_start": 20 }))).unwrap_err();
        assert!(err.starts_with("calendar_work_start:"), "{err}");
        // Nor the start (9 h by default).
        assert!(merge(&Document::new(), &doc(json!({ "calendar_work_end": 8 }))).is_err());
        assert!(merge(&Document::new(), &doc(json!({ "calendar_work_start": 17 }))).is_ok());
        assert!(merge(&Document::new(), &doc(json!({ "calendar_work_end": 10 }))).is_ok());
    }

    #[test]
    fn merge_refuses_an_oversized_document() {
        let mut bindings = Map::new();
        for i in 0..64 {
            bindings.insert(format!("command{i}"), Value::String("x".repeat(64)));
        }
        // Valid and under the bound on its own (64 bindings of 64 characters)...
        let mut patch = doc(json!({ "shortcuts": bindings }));
        assert!(merge(&Document::new(), &patch).is_ok());
        // ...but not with 500 space ids beside it.
        let order: Vec<String> = (0..500).map(|_| Uuid::new_v4().to_string()).collect();
        patch.insert("space_order".to_owned(), json!(order));
        assert_eq!(validate_patch(&patch), Ok(()));
        let err = merge(&Document::new(), &patch).unwrap_err();
        assert!(err.starts_with("preferences:"), "{err}");
    }

    #[test]
    fn split_then_join_round_trips() {
        let original = doc(json!({
            "font": "dyslexic",
            "emoji_animated": false,
            "locale": "it",
            "calendar_duration": 30
        }));
        let (font, animated, rest) = split(&original);
        assert_eq!(font.as_deref(), Some("dyslexic"));
        assert_eq!(animated, Some(false));
        assert!(!rest.contains_key("font"));
        let raw = Value::Object(rest).to_string();
        assert_eq!(join(font, animated, Some(&raw)), original);
    }

    #[test]
    fn join_leaves_out_what_no_longer_passes() {
        let joined = join(
            None,
            None,
            Some(r#"{"locale":"en","retired":1,"calendar_open_at":99}"#),
        );
        assert_eq!(joined, doc(json!({ "locale": "en" })));
        assert_eq!(join(None, None, Some("not json")), Document::new());
    }
}
