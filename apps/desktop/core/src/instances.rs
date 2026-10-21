//! The instances the person added, kept in a small JSON file of the app's data directory.
//!
//! Nothing secret lives here: the session tokens are in the system's keychain (`vault.rs`), one entry
//! per instance id. The list holds what the interface needs to show and reach an instance.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Why an address typed by the person is not an instance origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OriginError {
    Empty,
    NotHttps,
    HasPath,
    HasCredentials,
    Invalid,
}

/// Turn what the person typed into `https://host[:port]`, lowercase, or say why it cannot be one.
///
/// A bare host gets `https://`; a trailing slash is dropped. Plain `http://` is refused (a session
/// token must never travel in clear), and so is anything beyond the origin: a path, a query or
/// credentials would mean the address is not the instance itself.
pub fn normalise_origin(input: &str) -> Result<String, OriginError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(OriginError::Empty);
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| OriginError::Invalid)?;
    if url.scheme() != "https" {
        return Err(OriginError::NotHttps);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(OriginError::HasCredentials);
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(OriginError::HasPath);
    }
    let host = url.host_str().ok_or(OriginError::Invalid)?;
    Ok(match url.port() {
        Some(port) => format!("https://{host}:{port}"),
        None => format!("https://{host}"),
    })
}

/// Why an instance could not be added.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddError {
    /// The origin is already in the list, under this id.
    AlreadyThere(String),
}

/// One instance the person added.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Instance {
    /// Random, chosen by the app: it names the keychain entry and the `/i/<id>` path.
    pub id: String,
    /// `https://host[:port]`, as `normalise_origin` writes it.
    pub origin: String,
    /// The instance's own name, from `GET /api/v1/instance`.
    pub name: String,
    /// Seconds since the Unix epoch.
    pub added_at: i64,
}

/// Every instance added, and which one the interface shows.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstanceList {
    pub instances: Vec<Instance>,
    pub active: Option<String>,
}

impl InstanceList {
    /// Read the list. A missing or unreadable file is an empty list: the person adds an instance
    /// again, which is better than an app that will not start.
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Write the list, through a temporary file so a crash never leaves half of it.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)
    }

    /// Add an instance at the end of the list and open it. An origin already in the list is
    /// refused with the id it has.
    pub fn add(&mut self, origin: String, name: String) -> Result<Instance, AddError> {
        if let Some(known) = self.instances.iter().find(|i| i.origin == origin) {
            return Err(AddError::AlreadyThere(known.id.clone()));
        }
        let instance = Instance {
            id: random_id(),
            origin,
            name,
            added_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or_default(),
        };
        self.instances.push(instance.clone());
        self.active = Some(instance.id.clone());
        Ok(instance)
    }

    /// Forget an instance. When it was the open one, the next in the list opens (or the one before
    /// it, for the last), so the app keeps showing something while any instance is left.
    pub fn remove(&mut self, id: &str) {
        let Some(index) = self.instances.iter().position(|i| i.id == id) else {
            return;
        };
        self.instances.remove(index);
        if self.active.as_deref() == Some(id) {
            let next = index.min(self.instances.len().saturating_sub(1));
            self.active = self.instances.get(next).map(|i| i.id.clone());
        }
    }

    /// The instance the interface shows.
    pub fn active(&self) -> Option<&Instance> {
        let id = self.active.as_deref()?;
        self.instances.iter().find(|i| i.id == id)
    }

    /// An instance by id.
    pub fn get(&self, id: &str) -> Option<&Instance> {
        self.instances.iter().find(|i| i.id == id)
    }

    /// Open another instance; false when the id is unknown.
    pub fn open(&mut self, id: &str) -> bool {
        if self.get(id).is_none() {
            return false;
        }
        self.active = Some(id.to_string());
        true
    }
}

/// `bytes` random bytes, as lowercase hex.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the system's random source");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_id() -> String {
    random_hex(16)
}

/// Why an address answering HTTPS is not an instance the app can use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckError {
    /// Nothing answered in time (down, wrong address, or a server that never replies).
    Unreachable,
    /// Something answered, but not a Ruchoir instance.
    NotRuchoir,
    /// A Ruchoir instance too old to give an app its own session.
    Outdated,
}

/// How long the whole check may take before the app says the address cannot be reached.
pub const CHECK_WITHIN: std::time::Duration = std::time::Duration::from_secs(15);

/// Ask `GET /api/v1/instance` whether `origin` is a Ruchoir instance with native sessions, within
/// `within` for the whole exchange (connection, answer and body), so a server that accepts the
/// request and never replies does not leave the person waiting.
pub async fn check_instance(
    http: &reqwest::Client,
    origin: &str,
    within: std::time::Duration,
) -> Result<(), CheckError> {
    let ask = async {
        let answer = http
            .get(format!("{origin}/api/v1/instance"))
            .send()
            .await
            .map_err(|_| CheckError::Unreachable)?;
        answer
            .json::<serde_json::Value>()
            .await
            .map_err(|_| CheckError::NotRuchoir)
    };
    let body = tokio::time::timeout(within, ask)
        .await
        .map_err(|_| CheckError::Unreachable)??;
    match body.get("native_sessions").and_then(|v| v.as_bool()) {
        Some(true) => Ok(()),
        Some(false) => Err(CheckError::Outdated),
        // An instance from before native sessions still announces its upload limit.
        None if body.get("upload_max_bytes").is_some() => Err(CheckError::Outdated),
        None => Err(CheckError::NotRuchoir),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalise_origin_cases() {
        assert_eq!(
            normalise_origin("example.org").unwrap(),
            "https://example.org"
        );
        assert_eq!(
            normalise_origin(" HTTPS://Example.org/ ").unwrap(),
            "https://example.org"
        );
        assert_eq!(
            normalise_origin("https://example.org:8443").unwrap(),
            "https://example.org:8443"
        );
        assert!(matches!(
            normalise_origin("http://example.org"),
            Err(OriginError::NotHttps)
        ));
        assert!(matches!(
            normalise_origin("https://example.org/app"),
            Err(OriginError::HasPath)
        ));
        assert!(matches!(
            normalise_origin("https://example.org/?a=1"),
            Err(OriginError::HasPath)
        ));
        assert!(matches!(
            normalise_origin("https://u:p@example.org"),
            Err(OriginError::HasCredentials)
        ));
        assert!(matches!(normalise_origin(""), Err(OriginError::Empty)));
        assert!(matches!(
            normalise_origin("https://"),
            Err(OriginError::Invalid)
        ));
    }

    #[test]
    fn list_round_trips_and_holds_no_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("instances.json");
        let mut list = InstanceList::default();
        let added = list
            .add("https://a.example".into(), "Atelier".into())
            .unwrap();
        assert_eq!(added.id.len(), 32);
        assert_eq!(
            list.active().map(|i| i.id.as_str()),
            Some(added.id.as_str())
        );
        list.save(&path).unwrap();
        let loaded = InstanceList::load(&path);
        assert_eq!(loaded, list);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("token"));
    }

    #[test]
    fn a_missing_or_broken_file_is_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            InstanceList::load(&dir.path().join("none.json")),
            InstanceList::default()
        );
        let broken = dir.path().join("broken.json");
        std::fs::write(&broken, "{not json").unwrap();
        assert_eq!(InstanceList::load(&broken), InstanceList::default());
    }

    fn three() -> (InstanceList, Vec<Instance>) {
        let mut list = InstanceList::default();
        let added = ["a", "b", "c"]
            .iter()
            .map(|h| {
                list.add(format!("https://{h}.example"), h.to_string())
                    .unwrap()
            })
            .collect();
        (list, added)
    }

    #[test]
    fn adding_appends_and_opens() {
        let (list, added) = three();
        assert_eq!(list.instances.len(), 3);
        assert_eq!(list.instances[0].id, added[0].id);
        assert_eq!(list.active().unwrap().id, added[2].id);
    }

    #[test]
    fn the_same_origin_is_refused() {
        let (mut list, added) = three();
        let again = list.add("https://a.example".into(), "a".into());
        assert_eq!(again, Err(AddError::AlreadyThere(added[0].id.clone())));
        assert_eq!(list.instances.len(), 3);
    }

    #[test]
    fn removing_the_open_one_opens_the_next() {
        let (mut list, added) = three();
        assert!(list.open(&added[1].id));
        list.remove(&added[1].id);
        assert_eq!(list.active().unwrap().id, added[2].id);
        list.remove(&added[2].id);
        assert_eq!(list.active().unwrap().id, added[0].id);
        list.remove(&added[0].id);
        assert!(list.active().is_none());
    }

    #[test]
    fn opening_an_unknown_id_changes_nothing() {
        let (mut list, added) = three();
        assert!(!list.open("nope"));
        assert_eq!(list.active().unwrap().id, added[2].id);
    }
}
