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

    /// Add an instance and make it the active one. Step 1 of the desktop holds a single instance,
    /// so this replaces any other; step 2 lifts that.
    pub fn add(&mut self, origin: String, name: String) -> Instance {
        let instance = Instance {
            id: random_id(),
            origin,
            name,
            added_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or_default(),
        };
        self.instances = vec![instance.clone()];
        self.active = Some(instance.id.clone());
        instance
    }

    /// Forget an instance.
    pub fn remove(&mut self, id: &str) {
        self.instances.retain(|i| i.id != id);
        if self.active.as_deref() == Some(id) {
            self.active = self.instances.first().map(|i| i.id.clone());
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

    /// Show another instance.
    pub fn set_active(&mut self, id: &str) {
        if self.get(id).is_some() {
            self.active = Some(id.to_string());
        }
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
        let added = list.add("https://a.example".into(), "Atelier".into());
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

    #[test]
    fn step_one_holds_one_instance() {
        let mut list = InstanceList::default();
        list.add("https://a.example".into(), "A".into());
        let b = list.add("https://b.example".into(), "B".into());
        assert_eq!(list.instances.len(), 1);
        assert_eq!(list.active().unwrap().id, b.id);
        list.remove(&b.id);
        assert!(list.active().is_none());
    }
}
