//! Notification preferences, held by the server so that it can obey them.
//!
//! They used to live in the browser: the global switches in `localStorage`, the per-channel ones in
//! the memory of one tab. That was enough while every notification was drawn by an open page, and it
//! stops being enough the moment the server itself reaches out (a push to a closed browser, an email).
//! A channel muted on one device has to be muted for the server, or the phone rings for it anyway.
//!
//! Two layers, read together by [`allows`]:
//!
//! - **The person's own settings** ([`NotificationPrefs`]), one JSON document in
//!   `user_preferences.notifications`: the master switch, `@channel`, quiet hours, the email
//!   fallback.
//! - **Each conversation's setting** ([`ConversationPref`]), on the membership row that already
//!   carried the columns: `channel_members` for a channel, `dm_participants` for a direct message.
//!
//! Quiet hours are kept as the local wall-clock times the person typed, plus the offset of their
//! clock from UTC, which the client refreshes on every load. That follows a change of time zone or of
//! daylight saving time the next time the app is opened, without a time-zone database on the server.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::sea_query::OnConflict;
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, IntoActiveModel, QueryFilter,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{channel_members, dm_participants, user_preferences};
use crate::messaging::error::ApiError;
use crate::state::AppState;

/// The largest offset from UTC a clock can have (UTC+14, Kiribati), in minutes.
const MAX_OFFSET_MINUTES: i32 = 14 * 60;

/// A person's own notification settings.
///
/// Every field has a default, and a stored document missing a field (written before it existed)
/// takes that default rather than failing to load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(default)]
pub struct NotificationPrefs {
    /// Master switch: off, nothing notifies, anywhere.
    pub enabled: bool,
    /// Play a sound with a notification.
    pub sound: bool,
    /// Also notify on `@channel` and `@here`, not only when named.
    pub channel_mentions: bool,
    /// Hold notifications back during the window below.
    pub quiet_hours: bool,
    /// Start of the quiet window, `HH:MM`, in the person's local time. May be later than
    /// `quiet_to` for a window that runs past midnight.
    pub quiet_from: String,
    /// End of the quiet window, `HH:MM`, local time.
    pub quiet_to: String,
    /// Offset of the person's clock from UTC, in minutes (`+120` in Paris in summer).
    pub utc_offset_minutes: i32,
    /// Email what is still unread after a while, when no Ruchoir page is open.
    pub email: bool,
}

impl Default for NotificationPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            sound: false,
            channel_mentions: true,
            quiet_hours: false,
            quiet_from: "21:00".to_owned(),
            quiet_to: "08:00".to_owned(),
            utc_offset_minutes: 0,
            email: true,
        }
    }
}

/// Minutes since midnight for an `HH:MM` string, or `None` when it is not one.
fn minutes_of_day(hhmm: &str) -> Option<i32> {
    let (h, m) = hhmm.split_once(':')?;
    let (h, m): (i32, i32) = (h.parse().ok()?, m.parse().ok()?);
    ((0..24).contains(&h) && (0..60).contains(&m)).then_some(h * 60 + m)
}

impl NotificationPrefs {
    /// Refuse a document the server could not act on, rather than storing it and guessing later.
    fn validate(&self) -> Result<(), ApiError> {
        if minutes_of_day(&self.quiet_from).is_none() || minutes_of_day(&self.quiet_to).is_none() {
            return Err(ApiError::BadRequest("quiet hours must be HH:MM"));
        }
        if self.utc_offset_minutes.abs() > MAX_OFFSET_MINUTES {
            return Err(ApiError::BadRequest("utc offset out of range"));
        }
        Ok(())
    }

    /// Whether `at` falls inside the quiet window, read in the person's local time.
    ///
    /// The window may run past midnight (21:00 to 08:00 is the ordinary case), so it is read as two
    /// ranges when it starts later than it ends. An empty window (start equals end) is never quiet.
    pub fn in_quiet_hours(&self, at: OffsetDateTime) -> bool {
        if !self.quiet_hours {
            return false;
        }
        let (Some(from), Some(to)) = (
            minutes_of_day(&self.quiet_from),
            minutes_of_day(&self.quiet_to),
        ) else {
            return false;
        };
        if from == to {
            return false;
        }
        let utc = i32::from(at.hour()) * 60 + i32::from(at.minute());
        let now = (utc + self.utc_offset_minutes).rem_euclid(24 * 60);
        if from < to {
            now >= from && now < to
        } else {
            now >= from || now < to
        }
    }
}

/// How much one conversation notifies one person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ConversationPref {
    /// `all`, `mentions` or `none`.
    pub level: String,
    pub muted: bool,
}

impl Default for ConversationPref {
    fn default() -> Self {
        Self {
            level: "all".to_owned(),
            muted: false,
        }
    }
}

/// Whether a notification of `kind` should reach someone, given their settings and the
/// conversation's. Mirrors `passesPref` in `apps/web/features/app/notifications.ts`, which applies
/// the same rule to the inbox on screen: the two must agree, or the phone and the app disagree about
/// what was worth saying.
///
/// Quiet hours and "do not disturb" are not part of this: they decide *when*, not *whether*, and
/// the inbox shows the notification either way.
pub fn allows(
    kind: &str,
    prefs: &NotificationPrefs,
    conversation: Option<&ConversationPref>,
) -> bool {
    if !prefs.enabled {
        return false;
    }
    if kind == "broadcast" && !prefs.channel_mentions {
        return false;
    }
    let default = ConversationPref::default();
    let conversation = conversation.unwrap_or(&default);
    if conversation.muted || conversation.level == "none" {
        return false;
    }
    if conversation.level == "mentions" {
        return matches!(kind, "mention" | "broadcast" | "dm");
    }
    true
}

/// Whether someone may be interrupted right now: outside their quiet hours and not in "do not
/// disturb". What cannot interrupt them now is not lost: the inbox has it, and the email fallback
/// waits for the window to close.
pub fn may_interrupt(
    prefs: &NotificationPrefs,
    manual_presence: Option<&str>,
    at: OffsetDateTime,
) -> bool {
    manual_presence != Some("dnd") && !prefs.in_quiet_hours(at)
}

/// Read someone's settings, with the defaults for anything never saved.
pub async fn load<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
) -> Result<NotificationPrefs, ApiError> {
    let row = user_preferences::Entity::find_by_id(user_id)
        .one(db)
        .await?;
    Ok(row
        .and_then(|row| row.notifications)
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default())
}

/// The caller's settings for a set of conversations, keyed by conversation id. A conversation absent
/// from the map has no membership row for this person and notifies with the defaults.
pub async fn conversation_prefs<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
    conversation_ids: &[Uuid],
) -> Result<HashMap<Uuid, ConversationPref>, ApiError> {
    let mut out = HashMap::new();
    if conversation_ids.is_empty() {
        return Ok(out);
    }
    // A conversation is a channel or a direct message, never both, and the two share its id.
    for row in channel_members::Entity::find()
        .filter(channel_members::Column::UserId.eq(user_id))
        .filter(channel_members::Column::ChannelId.is_in(conversation_ids.to_vec()))
        .all(db)
        .await?
    {
        out.insert(
            row.channel_id,
            ConversationPref {
                level: row.notification_level,
                muted: row.muted,
            },
        );
    }
    for row in dm_participants::Entity::find()
        .filter(dm_participants::Column::UserId.eq(user_id))
        .filter(dm_participants::Column::DmId.is_in(conversation_ids.to_vec()))
        .all(db)
        .await?
    {
        out.insert(
            row.dm_id,
            ConversationPref {
                level: row.notification_level,
                muted: row.muted,
            },
        );
    }
    Ok(out)
}

/// `GET /api/v1/me/notification-preferences`: the caller's own notification settings.
#[utoipa::path(
    get,
    path = "/api/v1/me/notification-preferences",
    tag = "notifications",
    responses((status = 200, description = "Current settings", body = NotificationPrefs))
)]
pub async fn get_preferences(
    State(state): State<AppState>,
    session: AuthSession,
) -> Result<Json<NotificationPrefs>, ApiError> {
    Ok(Json(load(&state.db, session.user_id).await?))
}

/// `PUT /api/v1/me/notification-preferences`: replace the caller's notification settings.
#[utoipa::path(
    put,
    path = "/api/v1/me/notification-preferences",
    tag = "notifications",
    request_body = NotificationPrefs,
    responses(
        (status = 200, description = "Settings as stored", body = NotificationPrefs),
        (status = 400, description = "A time or offset the server cannot read")
    )
)]
pub async fn put_preferences(
    State(state): State<AppState>,
    session: AuthSession,
    Json(prefs): Json<NotificationPrefs>,
) -> Result<Json<NotificationPrefs>, ApiError> {
    prefs.validate()?;
    let json = serde_json::to_string(&prefs).map_err(|_| ApiError::Internal)?;
    let now = OffsetDateTime::now_utc();
    user_preferences::Entity::insert(user_preferences::ActiveModel {
        user_id: Set(session.user_id),
        notifications: Set(Some(json)),
        updated_at: Set(now),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::column(user_preferences::Column::UserId)
            .update_columns([
                user_preferences::Column::Notifications,
                user_preferences::Column::UpdatedAt,
            ])
            .to_owned(),
    )
    .exec(&state.db)
    .await?;
    Ok(Json(prefs))
}

/// `PUT /api/v1/conversations/{conversation_id}/notification-preference`: how much one channel or
/// direct message notifies the caller.
///
/// Written on the caller's own membership row, so only a member can set it: someone reading a public
/// channel they have not joined is not notified by it in the first place.
#[utoipa::path(
    put,
    path = "/api/v1/conversations/{conversation_id}/notification-preference",
    tag = "notifications",
    params(("conversation_id" = Uuid, Path, description = "Channel or direct-message id")),
    request_body = ConversationPref,
    responses(
        (status = 204, description = "Preference saved"),
        (status = 400, description = "Unknown level"),
        (status = 403, description = "Not a member of the conversation")
    )
)]
pub async fn put_conversation_preference(
    State(state): State<AppState>,
    session: AuthSession,
    Path(conversation_id): Path<Uuid>,
    Json(body): Json<ConversationPref>,
) -> Result<StatusCode, ApiError> {
    if !matches!(body.level.as_str(), "all" | "mentions" | "none") {
        return Err(ApiError::BadRequest("level must be all, mentions or none"));
    }
    if let Some(row) = channel_members::Entity::find_by_id((conversation_id, session.user_id))
        .one(&state.db)
        .await?
    {
        let mut active = row.into_active_model();
        active.notification_level = Set(body.level);
        active.muted = Set(body.muted);
        active.update(&state.db).await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    if let Some(row) = dm_participants::Entity::find_by_id((conversation_id, session.user_id))
        .one(&state.db)
        .await?
    {
        let mut active = row.into_active_model();
        active.notification_level = Set(body.level);
        active.muted = Set(body.muted);
        active.update(&state.db).await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    Err(ApiError::Forbidden)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A moment at `h:m` UTC. The date is irrelevant to a daily window.
    fn utc(h: i64, m: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(h * 3600 + m * 60).unwrap()
    }

    fn quiet(from: &str, to: &str, offset: i32) -> NotificationPrefs {
        NotificationPrefs {
            quiet_hours: true,
            quiet_from: from.to_owned(),
            quiet_to: to.to_owned(),
            utc_offset_minutes: offset,
            ..NotificationPrefs::default()
        }
    }

    #[test]
    fn an_overnight_window_is_read_in_local_time() {
        // 21:00 to 08:00 in Paris in summer (UTC+2). 20:30 UTC is 22:30 there: quiet.
        let prefs = quiet("21:00", "08:00", 120);
        assert!(prefs.in_quiet_hours(utc(20, 30)));
        // 06:30 UTC is 08:30 there: awake again.
        assert!(!prefs.in_quiet_hours(utc(6, 30)));
        // 04:00 UTC is 06:00 there: still the night.
        assert!(prefs.in_quiet_hours(utc(4, 0)));
    }

    #[test]
    fn a_daytime_window_and_a_negative_offset() {
        // 12:00 to 14:00 in New York in winter (UTC-5). 17:30 UTC is 12:30 there.
        let prefs = quiet("12:00", "14:00", -300);
        assert!(prefs.in_quiet_hours(utc(17, 30)));
        assert!(!prefs.in_quiet_hours(utc(19, 30)));
    }

    #[test]
    fn switched_off_or_empty_windows_are_never_quiet() {
        let mut prefs = quiet("09:00", "09:00", 0);
        assert!(!prefs.in_quiet_hours(utc(9, 0)));
        prefs.quiet_to = "10:00".to_owned();
        prefs.quiet_hours = false;
        assert!(!prefs.in_quiet_hours(utc(9, 30)));
    }

    #[test]
    fn the_server_rule_matches_the_inbox_rule() {
        let prefs = NotificationPrefs::default();
        let mentions_only = ConversationPref {
            level: "mentions".to_owned(),
            muted: false,
        };
        assert!(allows("reply", &prefs, None));
        assert!(!allows("reply", &prefs, Some(&mentions_only)));
        assert!(allows("mention", &prefs, Some(&mentions_only)));
        assert!(allows("dm", &prefs, Some(&mentions_only)));

        let muted = ConversationPref {
            level: "all".to_owned(),
            muted: true,
        };
        assert!(!allows("mention", &prefs, Some(&muted)));

        let no_broadcasts = NotificationPrefs {
            channel_mentions: false,
            ..NotificationPrefs::default()
        };
        assert!(!allows("broadcast", &no_broadcasts, None));
        assert!(allows("mention", &no_broadcasts, None));

        let off = NotificationPrefs {
            enabled: false,
            ..NotificationPrefs::default()
        };
        assert!(!allows("dm", &off, None));
    }

    #[test]
    fn do_not_disturb_holds_everything_back() {
        let prefs = NotificationPrefs::default();
        let now = utc(12, 0);
        assert!(may_interrupt(&prefs, None, now));
        assert!(may_interrupt(&prefs, Some("away"), now));
        assert!(!may_interrupt(&prefs, Some("dnd"), now));
    }

    #[test]
    fn a_document_from_before_a_field_existed_still_loads() {
        let old: NotificationPrefs = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(!old.enabled);
        assert!(old.email);
        assert_eq!(old.quiet_from, "21:00");
    }

    #[test]
    fn nonsense_times_are_refused() {
        assert!(quiet("25:00", "08:00", 0).validate().is_err());
        assert!(quiet("21:00", "8h", 0).validate().is_err());
        assert!(quiet("21:00", "08:00", 15 * 60).validate().is_err());
        assert!(quiet("21:00", "08:00", -120).validate().is_ok());
    }
}
