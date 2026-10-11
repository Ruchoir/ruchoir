//! Searching events: the title, place and notes of every event the viewer sees, its guests, and the
//! dates of a series changed alone; past and future, each event once.

use std::collections::{HashMap, HashSet};

use axum::extract::{Query, State};
use axum::Json;
use sea_orm::{ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, QueryFilter, Statement};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::attendees::{self, Attendance};
use super::authz::{self, CalendarAccess};
use super::dto::{OccurrenceDto, SearchQuery};
use super::error::CalendarError;
use super::events::{exception_inputs, exception_when, series_of, when_of, ViewerReminders};
use super::occurrences::occurrence_dto;
use super::recurrence::{self, Occurrence, RecurrenceId, SeriesInput, When};
use crate::auth::extract::AuthSession;
use crate::entities::{calendar_event_exceptions as exceptions, calendar_events};
use crate::state::AppState;

/// The most events one search returns.
pub const MAX_RESULTS: usize = 50;

/// The longest text searched for.
const MAX_QUERY_CHARS: usize = 200;

/// `GET /api/v1/calendar/search?q=`: the events whose words hold `q`, the coming ones first (each on
/// its next date), then the past ones (on their last date), latest first.
#[utoipa::path(
    get,
    path = "/api/v1/calendar/search",
    tag = "calendar",
    params(("q" = String, Query, description = "Words looked for, case and accents aside")),
    responses(
        (status = 200, description = "One occurrence per event found", body = [OccurrenceDto]),
        (status = 422, description = "Too long a text")
    )
)]
pub async fn search_events(
    State(state): State<AppState>,
    session: AuthSession,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<OccurrenceDto>>, CalendarError> {
    let words = query.q.trim();
    if words.is_empty() {
        return Ok(Json(Vec::new()));
    }
    if words.chars().count() > MAX_QUERY_CHARS {
        return Err(CalendarError::Invalid(
            "A search is 200 characters at most.",
        ));
    }

    let visible = authz::visible(&state.db, session.user_id).await?;
    let seen: HashSet<Uuid> = visible.iter().map(|a| a.calendar.id).collect();
    let mut accesses: HashMap<Uuid, CalendarAccess> =
        visible.into_iter().map(|a| (a.calendar.id, a)).collect();
    let calendar_ids: Vec<Uuid> = accesses.keys().copied().collect();
    let mut invited_ids: HashSet<Uuid> = HashSet::new();
    for (event, access) in attendees::invited_events(&state.db, session.user_id, &seen).await? {
        invited_ids.insert(event.id);
        accesses.entry(access.calendar.id).or_insert(access);
    }
    let invited: Vec<Uuid> = invited_ids.iter().copied().collect();

    let (whole, dates) = matching(&state.db, &calendar_ids, &invited, words).await?;
    let ids: Vec<Uuid> = whole.iter().chain(dates.keys()).copied().collect();
    if ids.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let events = calendar_events::Entity::find()
        .filter(calendar_events::Column::Id.is_in(ids.clone()))
        .all(&state.db)
        .await?;
    let mut by_event: HashMap<Uuid, Vec<exceptions::Model>> = HashMap::new();
    for row in exceptions::Entity::find()
        .filter(exceptions::Column::EventId.is_in(ids.clone()))
        .all(&state.db)
        .await?
    {
        by_event.entry(row.event_id).or_default().push(row);
    }
    let attendance = Attendance::load(&state.db, session.user_id, &ids).await?;
    let reminders = ViewerReminders::load(
        &state.db,
        session.user_id,
        ids,
        accesses.keys().copied().collect(),
    )
    .await?;

    let now = OffsetDateTime::now_utc();
    let mut found: Vec<(OffsetDateTime, OccurrenceDto)> = Vec::new();
    for event in &events {
        let Some(access) = accesses.get(&event.calendar_id) else {
            continue;
        };
        let rows = by_event.remove(&event.id).unwrap_or_default();
        let inputs = exception_inputs(&rows);
        let series = series_of(event, &inputs);
        let picked = if whole.contains(&event.id) {
            pick_whole(event, &series, now)?
        } else {
            let keys = dates.get(&event.id).cloned().unwrap_or_default();
            let changed: Vec<&exceptions::Model> = rows
                .iter()
                .filter(|r| keys.contains(&r.recurrence_id))
                .collect();
            pick_changed(&series, &changed, now)?
        };
        let Some(occurrence) = picked else { continue };
        let texts: HashMap<&str, &exceptions::Model> = rows
            .iter()
            .filter(|r| !r.cancelled)
            .map(|r| (r.recurrence_id.as_str(), r))
            .collect();
        let dto = occurrence_dto(
            event,
            access,
            &occurrence,
            &texts,
            &reminders.effective(event, &access.calendar),
            &attendance,
            session.user_id,
            invited_ids.contains(&event.id),
        );
        found.push((moment(&occurrence.when), dto));
    }
    // The coming ones first, soonest first; then the past ones, latest first.
    found.sort_by(|(a, x), (b, y)| {
        let (a_past, b_past) = (*a < now, *b < now);
        a_past
            .cmp(&b_past)
            .then(if a_past { b.cmp(a) } else { a.cmp(b) })
            .then(x.title.cmp(&y.title))
    });
    found.truncate(MAX_RESULTS);
    Ok(Json(found.into_iter().map(|(_, dto)| dto).collect()))
}

/// The events among `calendar_ids` or `invited` whose own words hold `words`, and, apart, the dates
/// of a series whose changed texts alone hold them (event id to recurrence ids).
async fn matching<C: ConnectionTrait>(
    db: &C,
    calendar_ids: &[Uuid],
    invited: &[Uuid],
    words: &str,
) -> Result<(HashSet<Uuid>, HashMap<Uuid, HashSet<String>>), CalendarError> {
    // The words are the pattern's content, never its syntax: a `%` or a `_` typed is looked for.
    let escaped = words
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let like = "ILIKE '%' || ruchoir_unaccent($3) || '%'";
    let field = |column: &str| format!("ruchoir_unaccent(coalesce({column}, '')) {like}");
    let scope = "(e.calendar_id = ANY($1) OR e.id = ANY($2))";
    let whole_sql = format!(
        "SELECT e.id FROM calendar_events e WHERE {scope} AND ({} OR {} OR {} OR EXISTS ( \
           SELECT 1 FROM calendar_event_attendees a LEFT JOIN users u ON u.id = a.user_id \
           WHERE a.event_id = e.id AND ({} OR {} OR {} OR {}))) \
         ORDER BY e.updated_at DESC LIMIT 200",
        field("e.title"),
        field("e.location"),
        field("e.description"),
        field("a.name"),
        field("a.email"),
        field("u.display_name"),
        field("u.email"),
    );
    let dates_sql = format!(
        "SELECT x.event_id, x.recurrence_id FROM calendar_event_exceptions x \
           JOIN calendar_events e ON e.id = x.event_id \
         WHERE {scope} AND NOT x.cancelled AND ({} OR {} OR {}) LIMIT 400",
        field("x.title"),
        field("x.location"),
        field("x.description"),
    );
    let values = || -> [sea_orm::Value; 3] {
        [
            calendar_ids.to_vec().into(),
            invited.to_vec().into(),
            escaped.clone().into(),
        ]
    };
    let whole: HashSet<Uuid> = db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            &whole_sql,
            values(),
        ))
        .await?
        .iter()
        .map(|row| row.try_get::<Uuid>("", "id"))
        .collect::<Result<_, _>>()?;
    let mut dates: HashMap<Uuid, HashSet<String>> = HashMap::new();
    for row in db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            &dates_sql,
            values(),
        ))
        .await?
    {
        let event: Uuid = row.try_get("", "event_id")?;
        if !whole.contains(&event) {
            dates
                .entry(event)
                .or_default()
                .insert(row.try_get("", "recurrence_id")?);
        }
    }
    Ok((whole, dates))
}

/// When an occurrence starts, a whole day at its UTC midnight: enough to tell past from coming.
fn moment(when: &When) -> OffsetDateTime {
    match *when {
        When::Timed { start, .. } => start,
        When::AllDay { start, .. } => start.midnight().assume_utc(),
    }
}

/// When an occurrence ends, the same way.
fn ending(when: &When) -> OffsetDateTime {
    match *when {
        When::Timed { end, .. } => end,
        When::AllDay { end, .. } => end.midnight().assume_utc(),
    }
}

/// An event found by its own words: its next date (one under way counts), else its last.
fn pick_whole(
    event: &calendar_events::Model,
    series: &SeriesInput,
    now: OffsetDateTime,
) -> Result<Option<Occurrence>, CalendarError> {
    let window = Duration::days(recurrence::MAX_WINDOW_DAYS);
    let day = Duration::days(1);
    let first = moment(&when_of(event));
    if event.rrule.is_none() && series.rdates.is_empty() {
        return Ok(recurrence::expand(series, first - day, first + day * 2)?
            .into_iter()
            .next());
    }
    let coming = recurrence::expand(series, now, now + window)?
        .into_iter()
        .find(|o| ending(&o.when) > now);
    if coming.is_some() {
        return Ok(coming);
    }
    // Over, or not begun yet beyond the window.
    let end = event.series_until.map_or(now, |until| until.min(now) + day);
    let past = recurrence::expand(series, end - window, end)?
        .into_iter()
        .rev()
        .find(|o| moment(&o.when) < now);
    if past.is_some() || first < now {
        return Ok(past);
    }
    Ok(
        recurrence::expand(series, first - day, first + window - day)?
            .into_iter()
            .next(),
    )
}

/// A series found by dates changed alone: the next of them, else the last.
fn pick_changed(
    series: &SeriesInput,
    changed: &[&exceptions::Model],
    now: OffsetDateTime,
) -> Result<Option<Occurrence>, CalendarError> {
    let mut moments: Vec<(OffsetDateTime, RecurrenceId)> = changed
        .iter()
        .filter_map(|row| {
            let id = RecurrenceId::from_key(&row.recurrence_id)?;
            let at = match exception_when(row) {
                Some(when) => moment(&when),
                None => match id {
                    RecurrenceId::Instant(instant) => instant,
                    RecurrenceId::Date(date) => date.midnight().assume_utc(),
                },
            };
            Some((at, id))
        })
        .collect();
    moments.sort();
    let chosen = moments
        .iter()
        .find(|(at, _)| *at >= now)
        .or_else(|| moments.last());
    let Some(&(at, id)) = chosen else {
        return Ok(None);
    };
    let day = Duration::days(1);
    Ok(recurrence::expand(series, at - day, at + day * 2)?
        .into_iter()
        .find(|o| o.recurrence_id == Some(id)))
}
