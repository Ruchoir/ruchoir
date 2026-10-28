//! Keeping apps and instances that were not updated working together (`docs/api-compatibility.md`).
//!
//! A phone or a computer runs whatever version of the app it last installed, against instances that
//! update on their own schedule. Two promises make that work:
//!
//! - **`/api/v1` only grows.** A route, a field, an event or a value an app may rely on is never
//!   removed, renamed or given another type or meaning; what is new is added beside it, and an app
//!   that does not know it ignores it. `the_v1_contract_only_grows` holds the instance to it against
//!   the recorded contract (`apps/api/contract/openapi-v1.json`).
//! - **The instance says what it can do** (`GET /api/v1/instance`: `version`, `api_version`,
//!   `features`), so a newer app asks before using something an older instance lacks, and does
//!   without it.

/// The major version of the API's paths (`/api/v1`). Raised only for a change `/api/v1` cannot
/// take, and then `/api/v1` keeps being served beside it.
pub const API_VERSION: u32 = 1;

/// What this instance can do beyond what every `/api/v1` instance can, by name. A name, once
/// listed, is never removed or reused for something else; an app checks for it before using what it
/// names, and does without on an instance that does not list it.
///
/// - `native_sessions`: sign-in hands a native app a session token (`session_delivery: "token"`).
/// - `notification_read`: reading a notification is announced to the person's other devices
///   (`notification.read`) and their phones are synced silently (ADR 0006).
pub const FEATURES: &[&str] = &["native_sessions", "notification_read", "recent_reactions"];

/// The release this instance was built from (`v1.2.3`, set by the release build), or `dev`.
pub fn version() -> &'static str {
    option_env!("RUCHOIR_VERSION")
        .filter(|v| !v.is_empty())
        .unwrap_or("dev")
}

/// The contract check (`the_v1_contract_only_grows`): only tests run it, against the recorded
/// contract, so it is compiled for them alone.
#[cfg(test)]
mod contract {
    use std::collections::{BTreeMap, BTreeSet};

    use serde_json::Value;

    /// The `type` and `$ref` of a schema node, which an app reads a value as.
    fn shape(node: &Value) -> Value {
        serde_json::json!({ "type": node.get("type"), "ref": node.get("$ref"), "items": node.get("items").map(shape) })
    }

    fn as_object(value: Option<&Value>) -> BTreeMap<String, Value> {
        value
            .and_then(Value::as_object)
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default()
    }

    fn names(value: Option<&Value>) -> BTreeSet<String> {
        value
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The schemas sent by apps (request bodies), by name: a field these newly require would be missing
    /// from every request an older app makes.
    fn request_schemas(doc: &Value) -> BTreeSet<String> {
        let mut found = BTreeSet::new();
        for (_, item) in as_object(doc.get("paths")) {
            for (_, operation) in as_object(Some(&item)) {
                for (_, media) in as_object(operation.pointer("/requestBody/content")) {
                    if let Some(name) = media
                        .pointer("/schema/$ref")
                        .and_then(Value::as_str)
                        .and_then(|r| r.rsplit('/').next())
                    {
                        found.insert(name.to_owned());
                    }
                }
            }
        }
        found
    }

    /// What `new` breaks for an app written against `old`, both OpenAPI documents; empty when `new`
    /// only adds. Reported: a route or method gone, a parameter newly required, a schema or a field
    /// gone, a field read as another type, a field no longer always present, a field newly required in
    /// what an app sends.
    pub fn breaking_changes(old: &Value, new: &Value) -> Vec<String> {
        let mut found = Vec::new();
        let new_paths = as_object(new.get("paths"));
        for (path, item) in as_object(old.get("paths")) {
            let Some(new_item) = new_paths.get(&path) else {
                found.push(format!("route {path} removed"));
                continue;
            };
            for (method, operation) in as_object(Some(&item)) {
                let Some(new_operation) = new_item.get(&method) else {
                    found.push(format!("{} {path} removed", method.to_uppercase()));
                    continue;
                };
                let before: BTreeSet<String> = operation
                    .get("parameters")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|p| p.get("name").and_then(Value::as_str).map(str::to_owned))
                    .collect();
                for parameter in new_operation
                    .get("parameters")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let name = parameter.get("name").and_then(Value::as_str).unwrap_or("");
                    let required = parameter.get("required").and_then(Value::as_bool) == Some(true);
                    let in_path = parameter.get("in").and_then(Value::as_str) == Some("path");
                    if required && !in_path && !before.contains(name) {
                        found.push(format!(
                            "{} {path}: parameter {name} newly required",
                            method.to_uppercase()
                        ));
                    }
                }
            }
        }

        let sent = request_schemas(new);
        let new_schemas = as_object(new.pointer("/components/schemas"));
        for (name, schema) in as_object(old.pointer("/components/schemas")) {
            let Some(new_schema) = new_schemas.get(&name) else {
                found.push(format!("schema {name} removed"));
                continue;
            };
            let new_properties = as_object(new_schema.get("properties"));
            let old_properties = as_object(schema.get("properties"));
            for (field, node) in &old_properties {
                match new_properties.get(field) {
                    None => found.push(format!("{name}.{field} removed")),
                    Some(new_node) if shape(new_node) != shape(node) => {
                        found.push(format!("{name}.{field} changed type"))
                    }
                    Some(_) => {}
                }
            }
            let required_before = names(schema.get("required"));
            let required_now = names(new_schema.get("required"));
            for field in required_before.difference(&required_now) {
                if new_properties.contains_key(field) {
                    found.push(format!("{name}.{field} no longer always present"));
                }
            }
            if sent.contains(&name) {
                for field in required_now.difference(&required_before) {
                    found.push(format!("{name}.{field} newly required in a request"));
                }
            }
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use super::contract::breaking_changes;
    use super::*;
    use serde_json::json;
    use serde_json::Value;

    /// A small contract: one route that takes `Draft` and answers `Note`.
    fn base() -> Value {
        json!({
            "paths": {
                "/api/v1/notes": {
                    "get": { "parameters": [{ "name": "limit", "in": "query", "required": false }] },
                    "post": {
                        "requestBody": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Draft" } } } }
                    }
                }
            },
            "components": { "schemas": {
                "Draft": { "type": "object", "required": ["text"], "properties": { "text": { "type": "string" } } },
                "Note": { "type": "object", "required": ["id", "text"], "properties": {
                    "id": { "type": "string" }, "text": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } }
                } }
            } }
        })
    }

    fn change(edit: impl FnOnce(&mut Value)) -> Vec<String> {
        let mut new = base();
        edit(&mut new);
        breaking_changes(&base(), &new)
    }

    #[test]
    fn the_same_contract_breaks_nothing() {
        assert!(breaking_changes(&base(), &base()).is_empty());
    }

    #[test]
    fn adding_breaks_nothing() {
        let found = change(|doc| {
            doc["paths"]["/api/v1/tags"] = json!({ "get": {} });
            doc["paths"]["/api/v1/notes"]["delete"] = json!({});
            doc["paths"]["/api/v1/notes"]["get"]["parameters"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "name": "before", "in": "query", "required": false }));
            doc["components"]["schemas"]["Tag"] = json!({ "type": "object" });
            // A new field in an answer, even always present; a new optional field in a request.
            doc["components"]["schemas"]["Note"]["properties"]["pinned"] =
                json!({ "type": "boolean" });
            doc["components"]["schemas"]["Note"]["required"] = json!(["id", "text", "pinned"]);
            doc["components"]["schemas"]["Draft"]["properties"]["color"] =
                json!({ "type": "string" });
        });
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn removing_a_route_a_method_a_schema_or_a_field_breaks() {
        assert_eq!(
            change(|doc| {
                doc["paths"]
                    .as_object_mut()
                    .unwrap()
                    .remove("/api/v1/notes");
            }),
            vec!["route /api/v1/notes removed"]
        );
        assert_eq!(
            change(|doc| {
                doc["paths"]["/api/v1/notes"]
                    .as_object_mut()
                    .unwrap()
                    .remove("get");
            }),
            vec!["GET /api/v1/notes removed"]
        );
        assert_eq!(
            change(|doc| {
                doc["components"]["schemas"]["Note"]["properties"]
                    .as_object_mut()
                    .unwrap()
                    .remove("tags");
            }),
            vec!["Note.tags removed"]
        );
        let found = change(|doc| {
            doc["components"]["schemas"]
                .as_object_mut()
                .unwrap()
                .remove("Note");
        });
        assert_eq!(found, vec!["schema Note removed"]);
    }

    #[test]
    fn reading_a_field_as_another_type_breaks() {
        assert_eq!(
            change(
                |doc| doc["components"]["schemas"]["Note"]["properties"]["id"] =
                    json!({ "type": "integer" })
            ),
            vec!["Note.id changed type"]
        );
        // Becoming nullable is a change too: an older app does not expect null there.
        assert_eq!(
            change(
                |doc| doc["components"]["schemas"]["Note"]["properties"]["text"] =
                    json!({ "type": ["string", "null"] })
            ),
            vec!["Note.text changed type"]
        );
        assert_eq!(
            change(
                |doc| doc["components"]["schemas"]["Note"]["properties"]["tags"]["items"] =
                    json!({ "type": "integer" })
            ),
            vec!["Note.tags changed type"]
        );
    }

    #[test]
    fn a_field_that_may_be_missing_now_breaks() {
        assert_eq!(
            change(|doc| doc["components"]["schemas"]["Note"]["required"] = json!(["id"])),
            vec!["Note.text no longer always present"]
        );
    }

    #[test]
    fn asking_more_of_an_older_app_breaks() {
        assert_eq!(
            change(|doc| {
                doc["components"]["schemas"]["Draft"]["properties"]["color"] =
                    json!({ "type": "string" });
                doc["components"]["schemas"]["Draft"]["required"] = json!(["text", "color"]);
            }),
            vec!["Draft.color newly required in a request"]
        );
        assert_eq!(
            change(|doc| {
                doc["paths"]["/api/v1/notes"]["get"]["parameters"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({ "name": "space", "in": "query", "required": true }));
            }),
            vec!["GET /api/v1/notes: parameter space newly required"]
        );
    }

    /// The contract as recorded, and as this code serves it, the release number set aside.
    fn contracts() -> (Value, Value, &'static str) {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/contract/openapi-v1.json");
        let recorded: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("the recorded contract"))
                .expect("the recorded contract is JSON");
        let current = serde_json::to_value(<crate::openapi::ApiDoc as utoipa::OpenApi>::openapi())
            .expect("the contract as JSON");
        (recorded, current, path)
    }

    fn without_release(mut doc: Value) -> Value {
        if let Some(info) = doc.get_mut("info").and_then(Value::as_object_mut) {
            info.remove("version");
        }
        doc
    }

    /// `/api/v1` only grows: nothing an app built against the recorded contract relies on may go.
    /// What was added must be recorded too, so the next change is measured against it:
    /// `RUCHOIR_UPDATE_CONTRACT=1 cargo test -p ruchoir-api the_v1_contract_only_grows` writes it
    /// (and refuses to while something breaks).
    #[test]
    fn the_v1_contract_only_grows() {
        let (recorded, current, path) = contracts();
        let broken = breaking_changes(&recorded, &current);
        assert!(
            broken.is_empty(),
            "/api/v1 must only grow (docs/api-compatibility.md); this breaks apps that were not updated:\n{}",
            broken.join("\n")
        );
        if std::env::var_os("RUCHOIR_UPDATE_CONTRACT").is_some() {
            let mut text = serde_json::to_string_pretty(&sort(current)).expect("json");
            text.push('\n');
            std::fs::write(path, text).expect("write the contract");
            return;
        }
        assert!(
            without_release(sort(recorded)) == without_release(sort(current)),
            "the API grew: record it with `RUCHOIR_UPDATE_CONTRACT=1 cargo test -p ruchoir-api the_v1_contract_only_grows`"
        );
    }

    /// Objects with their keys in order, as the recorded file keeps them.
    fn sort(value: Value) -> Value {
        match value {
            Value::Object(map) => {
                let sorted: BTreeMap<String, Value> =
                    map.into_iter().map(|(k, v)| (k, sort(v))).collect();
                Value::Object(sorted.into_iter().collect())
            }
            Value::Array(items) => Value::Array(items.into_iter().map(sort).collect()),
            other => other,
        }
    }

    #[test]
    fn features_are_names_listed_once() {
        let unique: BTreeSet<&str> = FEATURES.iter().copied().collect();
        assert_eq!(unique.len(), FEATURES.len());
        assert!(FEATURES
            .iter()
            .all(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')));
    }
}
