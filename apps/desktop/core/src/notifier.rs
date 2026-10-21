//! Which notification the desktop app draws, and where a click on it goes.
//!
//! The content comes from the instance's `GET /push/pending`, which already applies mutes and the
//! person's kinds, as for a phone. What is left to the app: the instance's own on/off switch and
//! quiet hours, nothing for the instance on screen while the window is focused, never the same item
//! twice (`since`, kept across restarts), and the path a click opens.

use serde::Deserialize;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::summary::{get_json, FetchError, SpaceSummary};

/// The instance's notification settings that the app applies itself (the others, the server does).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct NotifySettings {
    pub enabled: bool,
    pub sound: bool,
    pub quiet_hours: bool,
    /// `HH:MM`, the person's local time; may be later than `quiet_to` (a window past midnight).
    pub quiet_from: String,
    pub quiet_to: String,
}

impl Default for NotifySettings {
    /// The API's own defaults.
    fn default() -> Self {
        Self {
            enabled: true,
            sound: true,
            quiet_hours: false,
            quiet_from: "21:00".into(),
            quiet_to: "08:00".into(),
        }
    }
}

/// `GET /api/v1/me/notification-preferences`.
pub async fn fetch_settings(
    http: &reqwest::Client,
    origin: &str,
    token: &str,
) -> Result<NotifySettings, FetchError> {
    get_json(http, origin, token, "/api/v1/me/notification-preferences").await
}

fn minutes(hh_mm: &str) -> Option<u32> {
    let (h, m) = hh_mm.split_once(':')?;
    let (h, m) = (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// Whether `minute_of_day` (local) falls in the quiet window: from included, to excluded.
pub fn in_quiet_hours(s: &NotifySettings, minute_of_day: u32) -> bool {
    if !s.quiet_hours {
        return false;
    }
    let (Some(from), Some(to)) = (minutes(&s.quiet_from), minutes(&s.quiet_to)) else {
        return false;
    };
    if from <= to {
        (from..to).contains(&minute_of_day)
    } else {
        minute_of_day >= from || minute_of_day < to
    }
}

/// Whether to draw anything for this instance now. `on_screen`: it is the instance shown, in a
/// focused window, where the interface says it itself.
pub fn should_draw(s: &NotifySettings, minute_of_day: u32, on_screen: bool) -> bool {
    s.enabled && !on_screen && !in_quiet_hours(s, minute_of_day)
}

/// One notification, worded by the instance for the system tray (`notify/push.rs`, `PushItemDto`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PendingItem {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub space_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub event_id: Option<String>,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub channel_name: Option<String>,
    pub created_at: String,
}

/// What `push/pending` answers.
#[derive(Debug, Clone, Deserialize)]
pub struct Pending {
    /// Draw without a sound (the person's own setting).
    pub silent: bool,
    /// Newest first.
    pub items: Vec<PendingItem>,
}

/// `GET /api/v1/push/pending?since=`.
pub async fn fetch_pending(
    http: &reqwest::Client,
    origin: &str,
    token: &str,
    since: Option<&str>,
) -> Result<Pending, FetchError> {
    let path = match since {
        Some(since) => format!(
            "/api/v1/push/pending?since={}",
            url::form_urlencoded::byte_serialize(since.as_bytes()).collect::<String>()
        ),
        None => "/api/v1/push/pending".to_string(),
    };
    get_json(http, origin, token, &path).await
}

fn instant(text: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(text, &Rfc3339).ok()
}

/// The items strictly newer than `since`, oldest first (the order to draw them in).
pub fn fresh(items: &[PendingItem], since: Option<&str>) -> Vec<PendingItem> {
    let floor = since.and_then(instant);
    let mut kept: Vec<(OffsetDateTime, PendingItem)> = items
        .iter()
        .filter_map(|item| Some((instant(&item.created_at)?, item.clone())))
        .filter(|(at, _)| floor.is_none_or(|floor| *at > floor))
        .collect();
    kept.sort_by_key(|(at, _)| *at);
    kept.into_iter().map(|(_, item)| item).collect()
}

/// The new `since` once `drawn` were drawn: the newest of them, never earlier than `since`.
pub fn advance(since: Option<&str>, drawn: &[PendingItem]) -> Option<String> {
    let mut best: Option<(OffsetDateTime, String)> =
        since.and_then(|s| Some((instant(s)?, s.to_string())));
    for item in drawn {
        if let Some(at) = instant(&item.created_at) {
            if best.as_ref().is_none_or(|(b, _)| at > *b) {
                best = Some((at, item.created_at.clone()));
            }
        }
    }
    best.map(|(_, text)| text)
}

/// The interface path a click on `item` opens: its channel, else its space, else the instance.
pub fn target_path(item: &PendingItem, spaces: &[SpaceSummary]) -> String {
    let Some(space) = item
        .space_id
        .as_deref()
        .and_then(|id| spaces.iter().find(|s| s.id == id))
    else {
        return "/".to_string();
    };
    match &item.channel_name {
        Some(channel) => format!("/e/{}/c/{}", space.slug, channel),
        None => format!("/e/{}", space.slug),
    }
}
