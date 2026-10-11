//! Bringing calendars over: each one a personal calendar of its owner, each event read from the
//! iCalendar text its source kept.
//!
//! Two passes, after the conversations and before the files: the calendars (small, held in the
//! index), then the events, walked from the archive like the messages. Both are resumable the same
//! way as the rest: a calendar or an event already mapped is passed over.
//!
//! **An import is silent here too.** Nobody is told they were invited: the invitations are history,
//! answered or not long ago. Someone invited by address gets a token like any invitee, so the
//! organiser can send them the page again later, but no mail leaves.
//!
//! **One copy of each meeting.** A CalDAV server files a copy of an invitation in every invitee's
//! calendar, under the same UID. When the organiser came over too, their copy is the meeting and
//! the invitees see it as invited; the copies are passed over. When the organiser did not (an
//! invitation from outside), the invitee's copy becomes an event of their own.

use std::collections::HashMap;

use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ConnectionTrait, EntityTrait};
use time::OffsetDateTime;
use uuid::Uuid;

use super::archive::{CalendarRecord, EventRecord, Index, Member};
use super::run::{
    cancellation_asked, note_done, note_every, Counter, Mapper, Result, RunError, KIND_USER,
};
use crate::calendar::ics_import::{self, Head, Object, Override};
use crate::calendar::recurrence::{self, ExceptionInput, SeriesInput, When};
use crate::entities::{
    calendar_event_attendees, calendar_event_exceptions, calendar_event_reminders, calendar_events,
    calendars, users,
};

pub const KIND_CALENDAR: &str = "calendar";
pub const KIND_EVENT: &str = "event";

/// The zone an owner's floating times are read in when their profile names none.
const FALLBACK_ZONE: &str = crate::calendar::events::FALLBACK_TIME_ZONE;

/// What the calendar passes went through and wrote.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct CalendarsWritten {
    pub calendars_created: usize,
    pub calendars_seen: usize,
    pub events_created: usize,
    pub events_seen: usize,
    /// Copies of a meeting whose organiser came over too.
    pub copies_passed_over: usize,
    /// Events Ruchoir could not read, or cancelled as a whole, or of a calendar that did not cross.
    pub events_left_behind: usize,
    pub cancelled: bool,
}

/// The palette's colour closest in hue to a `#RRGGBB` (sky for anything unreadable or grey). The
/// pastels differ by hue far more than by lightness, so a strong blue is still sky.
pub fn nearest_colour(hex: &str) -> &'static str {
    let Some((hue, saturation)) = hue_of(hex) else {
        return "sky";
    };
    if saturation < 0.15 {
        return "sky";
    }
    ["sky", "mint", "violet", "pink", "peach", "lime", "sun"]
        .into_iter()
        .min_by_key(|name| {
            let (pastel, _) = hue_of(crate::calendar::ics::color_hex(name)).unwrap_or((0.0, 0.0));
            let gap = (pastel - hue).abs() % 360.0;
            (gap.min(360.0 - gap) * 10.0) as i32
        })
        .unwrap_or("sky")
}

/// The hue (degrees) and saturation (0 to 1) of a `#RRGGBB`.
fn hue_of(hex: &str) -> Option<(f32, f32)> {
    let hex = hex.strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let part = |i: usize| {
        u8::from_str_radix(&hex[i..i + 2], 16)
            .ok()
            .map(|v| f32::from(v) / 255.0)
    };
    let (r, g, b) = (part(0)?, part(2)?, part(4)?);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    if delta == 0.0 {
        return Some((0.0, 0.0));
    }
    let hue = if max == r {
        60.0 * (((g - b) / delta) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / delta + 2.0)
    } else {
        60.0 * ((r - g) / delta + 4.0)
    };
    Some(((hue + 360.0) % 360.0, delta / max))
}

/// The calendars, each a personal calendar of its owner. A calendar whose owner did not cross is
/// left behind: anyone else would be shown somebody's agenda.
pub async fn import_calendars<C: ConnectionTrait>(
    db: &C,
    mapper: &Mapper<'_>,
    index: &Index,
    written: &mut CalendarsWritten,
) -> Result<HashMap<String, (Uuid, Uuid)>> {
    let mut landed = HashMap::new();
    for record in &index.calendars {
        written.calendars_seen += 1;
        let Some(owner) = mapper.resolve(db, KIND_USER, &record.owner, None).await? else {
            continue;
        };
        let calendar_id = match mapper.resolve(db, KIND_CALENDAR, &record.id, None).await? {
            Some(id) => id,
            None => {
                let id = create_calendar(db, record, owner).await?;
                mapper
                    .record(db, KIND_CALENDAR, &record.id, None, id)
                    .await?;
                written.calendars_created += 1;
                id
            }
        };
        landed.insert(record.id.clone(), (calendar_id, owner));
        note_every(
            db,
            mapper.job_id,
            Counter::Calendars,
            written.calendars_seen,
        )
        .await?;
    }
    note_done(
        db,
        mapper.job_id,
        Counter::Calendars,
        written.calendars_seen,
    )
    .await?;
    Ok(landed)
}

async fn create_calendar<C: ConnectionTrait>(
    db: &C,
    record: &CalendarRecord,
    owner: Uuid,
) -> Result<Uuid> {
    let now = OffsetDateTime::now_utc();
    let id = Uuid::new_v4();
    let name: String = record.name.trim().chars().take(100).collect();
    let description = Some(
        record
            .description
            .trim()
            .chars()
            .take(2000)
            .collect::<String>(),
    )
    .filter(|d: &String| !d.is_empty());
    calendars::ActiveModel {
        id: Set(id),
        space_id: Set(None),
        owner_user_id: Set(Some(owner)),
        name: Set(name),
        description: Set(description),
        color: Set(nearest_colour(&record.color).to_owned()),
        write_access: Set("members".to_owned()),
        // The source's own alarms come with each event; nothing more is added on top.
        default_reminders: Set(Vec::new()),
        is_default: Set(false),
        created_by: Set(Some(owner)),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(db)
    .await?;
    Ok(id)
}

/// Who the archive's people are here, by address: the ones who crossed, as accounts.
async fn people_by_address<C: ConnectionTrait>(
    db: &C,
    mapper: &Mapper<'_>,
    index: &Index,
) -> Result<HashMap<String, Uuid>> {
    let mut found = HashMap::new();
    for user in &index.users {
        let email = user.email.trim().to_lowercase();
        if email.is_empty() {
            continue;
        }
        if let Some(id) = mapper.resolve(db, KIND_USER, &user.id, None).await? {
            found.insert(email, id);
        }
    }
    Ok(found)
}

/// The events, read from the archive.
#[allow(clippy::too_many_arguments)]
pub async fn import_events<C: ConnectionTrait>(
    db: &C,
    mapper: &Mapper<'_>,
    archive: &std::path::Path,
    passphrase: Option<&str>,
    index: &Index,
    calendars_by_source: &HashMap<String, (Uuid, Uuid)>,
    secret_key: &[u8; 32],
    written: &mut CalendarsWritten,
) -> Result<()> {
    let people = people_by_address(db, mapper, index).await?;
    let mut zones: HashMap<Uuid, String> = HashMap::new();
    let mut records: Vec<EventRecord> = Vec::new();
    super::archive::walk(archive, passphrase, |member| {
        if let Member::Event(event) = member {
            records.push(event);
        }
        Ok(())
    })
    .map_err(|e| RunError::Db(e.to_string()))?;

    for (n, record) in records.iter().enumerate() {
        if n % 100 == 0 && cancellation_asked(db, mapper.job_id).await? {
            written.cancelled = true;
            break;
        }
        written.events_seen += 1;
        note_every(db, mapper.job_id, Counter::Events, written.events_seen).await?;
        let Some(&(calendar_id, owner)) = calendars_by_source.get(&record.calendar) else {
            written.events_left_behind += 1;
            continue;
        };
        if mapper
            .resolve(db, KIND_EVENT, &record.id, None)
            .await?
            .is_some()
        {
            continue;
        }
        let zone = match zones.get(&owner) {
            Some(zone) => zone.clone(),
            None => {
                let zone = users::Entity::find_by_id(owner)
                    .one(db)
                    .await?
                    .and_then(|u| u.timezone)
                    .filter(|tz| recurrence::known_time_zone(tz))
                    .unwrap_or_else(|| FALLBACK_ZONE.to_owned());
                zones.insert(owner, zone.clone());
                zone
            }
        };
        let Ok(object) = ics_import::read(&record.ics, &zone) else {
            written.events_left_behind += 1;
            continue;
        };
        let Some(head) = object.head.as_ref() else {
            // One date of somebody else's series, with no series to hang it on.
            written.events_left_behind += 1;
            continue;
        };
        if head.cancelled {
            written.events_left_behind += 1;
            continue;
        }
        let owner_address = people
            .iter()
            .find(|(_, id)| **id == owner)
            .map(|(email, _)| email.as_str());
        let organizer = head.organizer.as_ref().map(|o| o.email.as_str());
        if let Some(organizer) = organizer {
            if Some(organizer) != owner_address && people.contains_key(organizer) {
                // The organiser's own copy carries the meeting.
                written.copies_passed_over += 1;
                continue;
            }
        }
        let Some(event_id) =
            write_event(db, calendar_id, owner, &object, head, &people, secret_key).await?
        else {
            written.events_left_behind += 1;
            continue;
        };
        mapper
            .record(db, KIND_EVENT, &record.id, None, event_id)
            .await?;
        written.events_created += 1;
    }
    note_done(db, mapper.job_id, Counter::Events, written.events_seen).await?;
    Ok(())
}

/// Writes one event and what hangs off it. `None` when the calendar already holds its UID (an event
/// written by hand since, or by an import whose correspondences were forgotten).
async fn write_event<C: ConnectionTrait>(
    db: &C,
    calendar_id: Uuid,
    owner: Uuid,
    object: &Object,
    head: &Head,
    people: &HashMap<String, Uuid>,
    secret_key: &[u8; 32],
) -> Result<Option<Uuid>> {
    use sea_orm::{ColumnTrait, QueryFilter};
    let taken = calendar_events::Entity::find()
        .filter(calendar_events::Column::CalendarId.eq(calendar_id))
        .filter(calendar_events::Column::Uid.eq(object.uid.clone()))
        .one(db)
        .await?
        .is_some();
    if taken {
        return Ok(None);
    }
    let now = OffsetDateTime::now_utc();
    let id = Uuid::new_v4();
    let exceptions: Vec<ExceptionInput> = head
        .exdates
        .iter()
        .map(|id| ExceptionInput {
            recurrence_id: *id,
            cancelled: true,
            when: None,
        })
        .chain(object.overrides.iter().map(|o| ExceptionInput {
            recurrence_id: o.recurrence_id,
            cancelled: o.cancelled,
            when: o.when,
        }))
        .collect();
    let until = recurrence::series_until(&SeriesInput {
        when: head.when,
        tzid: head.tzid.as_deref(),
        rrule: head.rrule.as_deref(),
        rdates: &head.rdates,
        exceptions: &exceptions,
    })
    .ok()
    .flatten();
    let title = if head.title.trim().is_empty() {
        "...".to_owned()
    } else {
        head.title.chars().take(500).collect()
    };
    let mut event = calendar_events::ActiveModel {
        id: Set(id),
        calendar_id: Set(calendar_id),
        uid: Set(object.uid.clone()),
        title: Set(title),
        description: Set(head.description.clone()),
        location: Set(head.location.clone()),
        rrule: Set(head.rrule.clone()),
        rdates: Set((!head.rdates.is_empty()).then(|| head.rdates.clone())),
        series_until: Set(until),
        sequence: Set(head.sequence),
        ical_extra: Set(serde_json::json!(head.extra)),
        created_by: Set(Some(owner)),
        updated_by: Set(Some(owner)),
        channel_id: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    };
    put_when(&mut event, &head.when, head.tzid.clone());
    event.insert(db).await?;

    // Cancelled dates, then the changed ones; a date both taken out and changed is changed.
    let mut keyed: HashMap<String, calendar_event_exceptions::ActiveModel> = HashMap::new();
    for date in &head.exdates {
        keyed.insert(
            date.to_key(),
            exception_row(id, date.to_key(), true, None, head),
        );
    }
    for changed in &object.overrides {
        let key = changed.recurrence_id.to_key();
        keyed.insert(
            key.clone(),
            exception_row(id, key, changed.cancelled, Some(changed), head),
        );
    }
    for row in keyed.into_values() {
        row.insert(db).await?;
    }

    for attendee in head
        .attendees
        .iter()
        .take(crate::calendar::attendees::MAX_ATTENDEES)
    {
        let user = people.get(&attendee.person.email).copied();
        if user == Some(owner) {
            continue;
        }
        let token = match user {
            Some(_) => None,
            None => Some(
                crate::calendar::attendees::new_token(secret_key)
                    .map_err(|_| RunError::Db("could not make an invitation token".to_owned()))?,
            ),
        };
        let (digest, cipher, nonce) = match token {
            Some((_, digest, cipher, nonce)) => (Some(digest), Some(cipher), Some(nonce)),
            None => (None, None, None),
        };
        calendar_event_attendees::ActiveModel {
            id: Set(Uuid::new_v4()),
            event_id: Set(id),
            user_id: Set(user),
            email: Set(user.is_none().then(|| attendee.person.email.clone())),
            name: Set(attendee
                .person
                .name
                .clone()
                .map(|n| n.chars().take(200).collect())),
            status: Set(attendee.status.to_owned()),
            token_digest: Set(digest),
            token_cipher: Set(cipher),
            token_nonce: Set(nonce),
            invited_by: Set(Some(owner)),
            invited_at: Set(now),
            responded_at: Set((attendee.status != "needs_action").then_some(now)),
        }
        .insert(db)
        .await?;
    }

    if !head.reminders.is_empty() {
        calendar_event_reminders::ActiveModel {
            user_id: Set(owner),
            event_id: Set(id),
            minutes: Set(head.reminders.clone()),
        }
        .insert(db)
        .await?;
    }
    Ok(Some(id))
}

fn exception_row(
    event_id: Uuid,
    recurrence_id: String,
    cancelled: bool,
    changed: Option<&Override>,
    head: &Head,
) -> calendar_event_exceptions::ActiveModel {
    // Only what differs from the series is the occurrence's own.
    let own = |value: Option<&String>, series: Option<&String>| {
        value.filter(|v| Some(*v) != series).cloned()
    };
    let mut row = calendar_event_exceptions::ActiveModel {
        event_id: Set(event_id),
        recurrence_id: Set(recurrence_id),
        cancelled: Set(cancelled),
        title: Set(changed.and_then(|c| own(c.title.as_ref(), Some(&head.title)))),
        description: Set(
            changed.and_then(|c| own(c.description.as_ref(), head.description.as_ref()))
        ),
        location: Set(changed.and_then(|c| own(c.location.as_ref(), head.location.as_ref()))),
        start_at: Set(None),
        end_at: Set(None),
        start_date: Set(None),
        end_date: Set(None),
        ical_extra: Set(serde_json::json!(changed
            .map(|c| c.extra.clone())
            .unwrap_or_default())),
    };
    if cancelled {
        return row;
    }
    // A time the occurrence would have anyway is not a move.
    let usual = recurrence::RecurrenceId::from_key(&key_of(&row))
        .map(|id| recurrence::occurrence_when(&head.when, id));
    match changed.and_then(|c| c.when).filter(|w| Some(*w) != usual) {
        Some(When::Timed { start, end }) => {
            row.start_at = Set(Some(start));
            row.end_at = Set(Some(end));
        }
        Some(When::AllDay { start, end }) => {
            row.start_date = Set(Some(start));
            row.end_date = Set(Some(end));
        }
        None => {}
    }
    row
}

fn key_of(row: &calendar_event_exceptions::ActiveModel) -> String {
    match &row.recurrence_id {
        sea_orm::ActiveValue::Set(key) | sea_orm::ActiveValue::Unchanged(key) => key.clone(),
        sea_orm::ActiveValue::NotSet => String::new(),
    }
}

fn put_when(event: &mut calendar_events::ActiveModel, when: &When, tzid: Option<String>) {
    match *when {
        When::Timed { start, end } => {
            event.all_day = Set(false);
            event.start_at = Set(Some(start));
            event.end_at = Set(Some(end));
            event.tzid = Set(tzid);
            event.start_date = Set(None);
            event.end_date = Set(None);
        }
        When::AllDay { start, end } => {
            event.all_day = Set(true);
            event.start_at = Set(None);
            event.end_at = Set(None);
            event.tzid = Set(None);
            event.start_date = Set(Some(start));
            event.end_date = Set(Some(end));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_land_on_the_nearest_pastel() {
        assert_eq!(nearest_colour("#0082c9"), "sky");
        assert_eq!(nearest_colour("#ffd700"), "sun");
        assert_eq!(nearest_colour("#e9322d"), "peach");
        assert_eq!(nearest_colour("not a colour"), "sky");
        assert_eq!(nearest_colour("#808080"), "sky");
        assert_eq!(nearest_colour("#46ba61"), "lime");
    }
}
