//! What each instance holds, for the rail and the badge, while its interface is not on screen: its
//! spaces with their activity and mention counts, and its unread notifications. Fetched by the core
//! after an event that can change them, at most once per two seconds.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// The whole exchange with an instance may take this long before it counts as unreachable.
const WITHIN: Duration = Duration::from_secs(15);

/// No more than one refresh per instance in this window.
const DEBOUNCE: Duration = Duration::from_secs(2);

/// One space, as the rail draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceSummary {
    pub id: String,
    pub slug: String,
    pub name: String,
    /// The instance-relative path the API gives; the interface prefixes `/i/<id>`.
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub unread: u32,
    #[serde(default)]
    pub mentions: u32,
}

/// What an instance holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Summary {
    pub spaces: Vec<SpaceSummary>,
    pub unread_notifications: u32,
}

/// Why an instance could not be asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// The session ended: sign this instance out.
    Unauthorized,
    /// Down, slow or not answering as expected: try again at the next event.
    Unreachable,
}

/// `GET path` on the instance with the bearer, parsed as `T`.
pub(crate) async fn get_json<T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    origin: &str,
    token: &str,
    path: &str,
) -> Result<T, FetchError> {
    let ask = async {
        let response = http
            .get(format!("{origin}{path}"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| FetchError::Unreachable)?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(FetchError::Unauthorized);
        }
        if !response.status().is_success() {
            return Err(FetchError::Unreachable);
        }
        response
            .json::<T>()
            .await
            .map_err(|_| FetchError::Unreachable)
    };
    tokio::time::timeout(WITHIN, ask)
        .await
        .map_err(|_| FetchError::Unreachable)?
}

#[derive(Deserialize)]
struct UnreadPage {
    unread_count: u32,
}

/// Ask an instance for its spaces and its unread notification count.
pub async fn fetch_summary(
    http: &reqwest::Client,
    origin: &str,
    token: &str,
) -> Result<Summary, FetchError> {
    let spaces: Vec<SpaceSummary> = get_json(http, origin, token, "/api/v1/me/spaces").await?;
    let page: UnreadPage = get_json(
        http,
        origin,
        token,
        "/api/v1/notifications?unread=true&limit=1",
    )
    .await?;
    Ok(Summary {
        spaces,
        unread_notifications: page.unread_count,
    })
}

/// Whether a realtime event can change what the rail or the badge shows.
pub fn wants_refresh(event_type: &str) -> bool {
    matches!(
        event_type,
        "message.created"
            | "message.deleted"
            | "read.updated"
            | "notification.created"
            | "notification.read"
    ) || ["space.", "member.", "channel."]
        .iter()
        .any(|prefix| event_type.starts_with(prefix))
}

/// Lets one refresh through per two-second window; the caller schedules the trailing one.
#[derive(Debug, Default)]
pub struct Debounce {
    last: Option<Instant>,
}

impl Debounce {
    /// Whether a refresh may run now.
    pub fn hit(&mut self, now: Instant) -> bool {
        match self.last {
            Some(last) if now.duration_since(last) < DEBOUNCE => false,
            _ => {
                self.last = Some(now);
                true
            }
        }
    }
}
