//! An event and a channel: which channels an event may be linked to, what a linked channel shows of
//! it, and the cards announcing it there.
//!
//! - **Linking.** To an event of a space's calendar: a channel of that space its author reads (a
//!   public one, or a private one they are in). To an event of a personal calendar: such a channel
//!   of any of their spaces. Never a direct conversation, never an archived channel.
//! - **Seeing.** Whoever reads the linked channel sees the event, read only, as an invitee does.
//!   Whoever sees the event without reading a private linked channel is told there is one, unnamed.
//! - **Cards.** Linking posts a card into the channel: a system message pointing at the event, drawn
//!   as the event stands for each reader. A new time or place adds a short notice, and so does a
//!   deletion, which keeps the title in its body since the event is gone.
//! - **Upcoming.** A channel lists its next linked occurrences under its header.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::Json;
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde::Serialize;
use time::{Duration, OffsetDateTime};
use utoipa::ToSchema;
use uuid::Uuid;

use super::attendees::{self, Attendance};
use super::authz::{self, CalendarAccess};
use super::error::CalendarError;
use super::events::{exception_inputs, series_of, when_texts};
use super::recurrence;
use crate::auth::extract::AuthSession;
use crate::entities::{
    calendar_event_exceptions as exceptions, calendar_events, calendars, channel_members, channels,
    messages, space_members, spaces,
};
use crate::realtime::event::RealtimeEnvelope;
use crate::state::AppState;

/// The system events a calendar card writes.
pub const POSTED: &str = "calendar_event_posted";
pub const CHANGED: &str = "calendar_event_changed";
pub const CANCELLED: &str = "calendar_event_cancelled";

/// How many upcoming occurrences a channel shows, and how far ahead it looks.
const UPCOMING: usize = 3;
const UPCOMING_DAYS: i64 = 60;

/// The channel an event is linked to, as its viewer may know it.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ChannelDto {
    pub id: Uuid,
    /// Absent for a private channel the viewer is not in.
    pub name: Option<String>,
    pub space_id: Uuid,
    pub private: bool,
    /// Whether the viewer reads it (and may open it).
    pub accessible: bool,
}

/// A channel an event may be linked to.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct LinkableChannelDto {
    pub id: Uuid,
    pub name: String,
    pub space_id: Uuid,
    pub space_name: String,
    pub private: bool,
}

/// An event as its card in a channel shows it to one reader.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EventCardDto {
    pub event_id: Uuid,
    pub title: String,
    /// Its next occurrence from now (its first, once it is over): RFC 3339 in UTC, or a date.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub tzid: Option<String>,
    pub location: Option<String>,
    pub recurring: bool,
    /// Who organises it.
    pub organizer: Option<String>,
    /// Their account, so that the card does not ask them for an answer.
    pub organizer_id: Option<Uuid>,
    /// The reader's answer, when they are invited (`accepted` for the organiser of an event with
    /// attendees).
    pub my_status: Option<String>,
    /// That occurrence, for answering for one date.
    pub recurrence_id: Option<String>,
}

/// An occurrence a channel lists as upcoming.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct UpcomingDto {
    pub event_id: Uuid,
    pub recurrence_id: Option<String>,
    pub title: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub location: Option<String>,
}

/// Whether `user` reads the channel (a conversation of kind `channel`).
pub async fn reads(db: &DatabaseConnection, channel_id: Uuid, user: Uuid) -> bool {
    crate::messaging::authz::ensure_conversation_access(db, channel_id, user)
        .await
        .is_ok()
}

/// The channels `user` may link an event of `calendar` to, by name.
pub async fn linkable(
    db: &DatabaseConnection,
    calendar: &calendars::Model,
    user: Uuid,
) -> Result<Vec<LinkableChannelDto>, CalendarError> {
    let space_ids: Vec<Uuid> = match calendar.space_id {
        Some(space) => vec![space],
        None => space_members::Entity::find()
            .filter(space_members::Column::UserId.eq(user))
            .all(db)
            .await?
            .into_iter()
            .map(|m| m.space_id)
            .collect(),
    };
    let space_names: HashMap<Uuid, String> = spaces::Entity::find()
        .filter(spaces::Column::Id.is_in(space_ids.clone()))
        .all(db)
        .await?
        .into_iter()
        .map(|s| (s.id, s.name))
        .collect();
    let candidates = channels::Entity::find()
        .filter(channels::Column::SpaceId.is_in(space_ids))
        .filter(channels::Column::ChannelType.is_in(["public", "private"]))
        .filter(channels::Column::ArchivedAt.is_null())
        .all(db)
        .await?;
    let mut found = Vec::new();
    for channel in candidates {
        if reads(db, channel.id, user).await {
            found.push(LinkableChannelDto {
                id: channel.id,
                space_name: space_names
                    .get(&channel.space_id)
                    .cloned()
                    .unwrap_or_default(),
                space_id: channel.space_id,
                private: channel.channel_type == "private",
                name: channel.name,
            });
        }
    }
    found.sort_by(|a, b| {
        (a.space_name.to_lowercase(), a.name.to_lowercase())
            .cmp(&(b.space_name.to_lowercase(), b.name.to_lowercase()))
    });
    Ok(found)
}

/// Refuse a channel `user` may not link an event of `calendar` to.
pub async fn check(
    db: &DatabaseConnection,
    calendar: &calendars::Model,
    user: Uuid,
    channel_id: Uuid,
) -> Result<(), CalendarError> {
    let allowed = linkable(db, calendar, user)
        .await?
        .iter()
        .any(|c| c.id == channel_id);
    if allowed {
        Ok(())
    } else {
        Err(CalendarError::Invalid(
            "This channel cannot be linked to this event.",
        ))
    }
}

/// The linked channel as `viewer` may know it.
pub async fn channel_dto(
    db: &DatabaseConnection,
    channel_id: Option<Uuid>,
    viewer: Uuid,
) -> Result<Option<ChannelDto>, CalendarError> {
    let Some(id) = channel_id else {
        return Ok(None);
    };
    let Some(channel) = channels::Entity::find_by_id(id).one(db).await? else {
        return Ok(None);
    };
    let accessible = reads(db, id, viewer).await;
    let private = channel.channel_type == "private";
    Ok(Some(ChannelDto {
        id,
        name: (accessible || !private).then_some(channel.name),
        space_id: channel.space_id,
        private,
        accessible,
    }))
}

/// Whether `user` sees `event` through its linked channel alone: read only.
pub async fn channel_access(
    db: &DatabaseConnection,
    user: Uuid,
    event: &calendar_events::Model,
) -> Result<Option<CalendarAccess>, CalendarError> {
    let Some(channel) = event.channel_id else {
        return Ok(None);
    };
    if !reads(db, channel, user).await {
        return Ok(None);
    }
    Ok(calendars::Entity::find_by_id(event.calendar_id)
        .one(db)
        .await?
        .map(CalendarAccess::read_only))
}

/// How `user` sees `event`, if they do: through its calendar, an invitation, or its channel.
pub async fn reach(
    db: &DatabaseConnection,
    user: Uuid,
    event: &calendar_events::Model,
) -> Result<Option<CalendarAccess>, CalendarError> {
    match authz::access(db, user, event.calendar_id).await {
        Ok(access) => return Ok(Some(access)),
        Err(CalendarError::NotFound) => {}
        Err(other) => return Err(other),
    }
    if let Some(access) = attendees::invitation_access(db, user, event).await? {
        return Ok(Some(access));
    }
    channel_access(db, user, event).await
}

/// Post a card or a notice about an event into a channel, from `actor`, and show it to whoever is
/// there. Best effort: a failure is a missing line in a history, never a failed change.
pub async fn post(
    state: &AppState,
    channel_id: Uuid,
    event_id: Option<Uuid>,
    actor: Uuid,
    kind: &str,
    title: &str,
) {
    let row = messages::ActiveModel {
        id: Set(Uuid::new_v4()),
        conversation_id: Set(channel_id),
        author_id: Set(Some(actor)),
        kind: Set("system".to_owned()),
        body: Set(title.to_owned()),
        system_event: Set(Some(kind.to_owned())),
        event_id: Set(event_id),
        created_at: Set(OffsetDateTime::now_utc()),
        ..Default::default()
    }
    .insert(&state.db)
    .await;
    let row = match row {
        Ok(row) => row,
        Err(error) => {
            tracing::warn!(%error, "could not post a calendar card");
            return;
        }
    };
    let Ok(members) = channel_members::Entity::find()
        .filter(channel_members::Column::ChannelId.eq(channel_id))
        .all(&state.db)
        .await
    else {
        return;
    };
    if let Ok(mut dtos) =
        crate::messaging::messages::hydrate_messages(&state.db, actor, vec![row]).await
    {
        if let Some(mut dto) = dtos.pop() {
            // The card goes out to everyone alike: each reader's own answer comes with the history.
            if let Some(card) = dto.event.as_mut() {
                card.my_status = None;
            }
            state
                .hub
                .publish(
                    members.into_iter().map(|m| m.user_id).collect(),
                    RealtimeEnvelope::message_created(channel_id, &dto),
                )
                .await;
        }
    }
}

/// The cards of some messages, each drawn for `reader` if they still see its event.
pub async fn cards(
    db: &DatabaseConnection,
    reader: Uuid,
    event_ids: Vec<Uuid>,
) -> Result<HashMap<Uuid, EventCardDto>, CalendarError> {
    if event_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let events = calendar_events::Entity::find()
        .filter(calendar_events::Column::Id.is_in(event_ids))
        .all(db)
        .await?;
    let ids: Vec<Uuid> = events.iter().map(|e| e.id).collect();
    let attendance = Attendance::load(db, reader, &ids).await?;
    let organizers = attendees::names(db, events.iter().filter_map(|e| e.created_by)).await?;
    let mut by_event: HashMap<Uuid, Vec<exceptions::Model>> = HashMap::new();
    for row in exceptions::Entity::find()
        .filter(exceptions::Column::EventId.is_in(ids))
        .all(db)
        .await?
    {
        by_event.entry(row.event_id).or_default().push(row);
    }
    let now = OffsetDateTime::now_utc();
    let mut found = HashMap::new();
    for event in events {
        if reach(db, reader, &event).await?.is_none() {
            continue;
        }
        let rows = by_event.remove(&event.id).unwrap_or_default();
        let inputs = exception_inputs(&rows);
        let next = recurrence::expand(
            &series_of(&event, &inputs),
            now,
            now + Duration::days(recurrence::MAX_WINDOW_DAYS),
        )
        .ok()
        .and_then(|o| o.into_iter().next());
        let (when, recurrence_id) = match next {
            Some(occurrence) => (occurrence.when, occurrence.recurrence_id),
            None => (super::events::when_of(&event), None),
        };
        let key = recurrence_id.map(|id| id.to_key());
        let (start, end) = when_texts(&when);
        found.insert(
            event.id,
            EventCardDto {
                event_id: event.id,
                title: event.title.clone(),
                start,
                end,
                all_day: event.all_day,
                tzid: event.tzid.clone(),
                location: event.location.clone(),
                recurring: event.rrule.is_some(),
                organizer: event.created_by.and_then(|o| organizers.get(&o).cloned()),
                organizer_id: event.created_by,
                my_status: attendance.status(&event, reader, key.as_deref()),
                recurrence_id: if event.rrule.is_some() { key } else { None },
            },
        );
    }
    Ok(found)
}

/// `GET /api/v1/calendars/{calendar_id}/channels`: the channels an event of this calendar may be
/// linked to, for whoever may write in it.
#[utoipa::path(
    get,
    path = "/api/v1/calendars/{calendar_id}/channels",
    tag = "calendar",
    params(("calendar_id" = Uuid, Path, description = "Calendar id")),
    responses(
        (status = 200, description = "By space, then by name", body = [LinkableChannelDto]),
        (status = 403, description = "May not write in this calendar"),
        (status = 404, description = "No such calendar for the caller")
    )
)]
pub async fn list_linkable(
    State(state): State<AppState>,
    session: AuthSession,
    Path(calendar_id): Path<Uuid>,
) -> Result<Json<Vec<LinkableChannelDto>>, CalendarError> {
    let access = authz::access(&state.db, session.user_id, calendar_id).await?;
    if !access.can_write_events {
        return Err(CalendarError::Forbidden);
    }
    Ok(Json(
        linkable(&state.db, &access.calendar, session.user_id).await?,
    ))
}

/// `GET /api/v1/channels/{channel_id}/events`: the channel's next linked occurrences.
#[utoipa::path(
    get,
    path = "/api/v1/channels/{channel_id}/events",
    tag = "calendar",
    params(("channel_id" = Uuid, Path, description = "Channel id")),
    responses(
        (status = 200, description = "Up to three, in order", body = [UpcomingDto]),
        (status = 403, description = "Not a reader of the channel")
    )
)]
pub async fn upcoming(
    State(state): State<AppState>,
    session: AuthSession,
    Path(channel_id): Path<Uuid>,
) -> Result<Json<Vec<UpcomingDto>>, CalendarError> {
    if !reads(&state.db, channel_id, session.user_id).await {
        return Err(CalendarError::Forbidden);
    }
    let now = OffsetDateTime::now_utc();
    let to = now + Duration::days(UPCOMING_DAYS);
    let events = calendar_events::Entity::find()
        .filter(calendar_events::Column::ChannelId.eq(channel_id))
        .all(&state.db)
        .await?;
    let mut by_event: HashMap<Uuid, Vec<exceptions::Model>> = HashMap::new();
    for row in exceptions::Entity::find()
        .filter(exceptions::Column::EventId.is_in(events.iter().map(|e| e.id)))
        .all(&state.db)
        .await?
    {
        by_event.entry(row.event_id).or_default().push(row);
    }
    let mut found = Vec::new();
    for event in &events {
        let rows = by_event.remove(&event.id).unwrap_or_default();
        let titles: HashMap<String, &exceptions::Model> = rows
            .iter()
            .filter(|r| !r.cancelled)
            .map(|r| (r.recurrence_id.clone(), r))
            .collect();
        let inputs = exception_inputs(&rows);
        for occurrence in recurrence::expand(&series_of(event, &inputs), now, to)? {
            let key = occurrence.recurrence_id.map(|id| id.to_key());
            let own = key.as_deref().and_then(|k| titles.get(k));
            let (start, end) = when_texts(&occurrence.when);
            found.push(UpcomingDto {
                event_id: event.id,
                recurrence_id: key.clone(),
                title: own
                    .and_then(|r| r.title.clone())
                    .unwrap_or_else(|| event.title.clone()),
                start,
                end,
                all_day: event.all_day,
                location: match own {
                    Some(r) => r.location.clone(),
                    None => event.location.clone(),
                },
            });
        }
    }
    found.sort_by(|a, b| a.start.cmp(&b.start));
    found.truncate(UPCOMING);
    Ok(Json(found))
}
