//! Reading one calendar object of an import: the `VCALENDAR` text a CalDAV server keeps per UID (a
//! series and the occurrences changed apart from it), turned into what `calendar_events` and its
//! companion tables hold.
//!
//! Nothing here touches the database: the importer (`importer/calendars.rs`) decides who the people
//! are and writes the rows. What this module settles is what the text says:
//!
//! - **When.** A date (`VALUE=DATE`), an instant in UTC, a wall time in a named zone, or a floating
//!   time read in the owner's zone. A zone name is taken as IANA, or brought back to it when a client
//!   wrote it its own way (a path ending in `Region/City`, a Windows name); a zone still unknown is
//!   read in the owner's zone and reported.
//! - **The series.** The bare `RRULE` (an import may repeat more often than daily), `RDATE`s,
//!   `EXDATE`s as cancelled occurrences, and every component carrying a `RECURRENCE-ID` as a changed
//!   occurrence (or a cancelled one, when its status says so).
//! - **People.** The organiser and the attendees with their answers, by address.
//! - **The reminder.** The first alarm set relative to the start, as Ruchoir's delays offer them.
//! - **Everything else** is kept as content lines in `ical_extra`, to be written back in the feed.

use icalendar::parser::{read_calendar, unfold, Component, Property};
use time::{Date, Duration, OffsetDateTime};

use super::recurrence::{self, RecurrenceId, When};
use super::reminders::{MAX_LEAD_MINUTES, MAX_REMINDERS};

/// Properties read into columns, or rebuilt from them; never kept as extra lines.
const HANDLED: &[&str] = &[
    "UID",
    "DTSTAMP",
    "DTSTART",
    "DTEND",
    "DURATION",
    "SUMMARY",
    "DESCRIPTION",
    "LOCATION",
    "RRULE",
    "RDATE",
    "EXDATE",
    "RECURRENCE-ID",
    "SEQUENCE",
    "ORGANIZER",
    "ATTENDEE",
    "STATUS",
    "CREATED",
    "LAST-MODIFIED",
];

/// Windows zone names some clients write, brought back to the IANA zone they stand for.
const WINDOWS_ZONES: &[(&str, &str)] = &[
    ("Romance Standard Time", "Europe/Paris"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("Central Europe Standard Time", "Europe/Budapest"),
    ("Central European Standard Time", "Europe/Warsaw"),
    ("GMT Standard Time", "Europe/London"),
    ("Greenwich Standard Time", "Atlantic/Reykjavik"),
    ("GTB Standard Time", "Europe/Bucharest"),
    ("FLE Standard Time", "Europe/Helsinki"),
    ("E. Europe Standard Time", "Europe/Chisinau"),
    ("Russian Standard Time", "Europe/Moscow"),
    ("UTC", "UTC"),
    ("Eastern Standard Time", "America/New_York"),
    ("Central Standard Time", "America/Chicago"),
    ("Mountain Standard Time", "America/Denver"),
    ("Pacific Standard Time", "America/Los_Angeles"),
];

/// An answer as Ruchoir names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Person {
    pub email: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attendee {
    pub person: Person,
    /// `needs_action`, `accepted`, `tentative` or `declined`.
    pub status: &'static str,
}

/// A changed (or cancelled) occurrence of a series.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Override {
    pub recurrence_id: RecurrenceId,
    pub cancelled: bool,
    pub title: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    /// Its own time, when it has one.
    pub when: Option<When>,
    pub extra: Vec<String>,
}

/// The head of a series, or an event that does not repeat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub when: When,
    /// The IANA zone a timed event was written in (`UTC` for a time written in UTC); `None` for a
    /// whole day.
    pub tzid: Option<String>,
    pub rrule: Option<String>,
    pub rdates: Vec<OffsetDateTime>,
    /// Dates taken out of the series (`EXDATE`), stored as cancelled occurrences.
    pub exdates: Vec<RecurrenceId>,
    pub sequence: i32,
    pub organizer: Option<Person>,
    pub attendees: Vec<Attendee>,
    /// The first alarm before the start, as one of Ruchoir's delays.
    pub reminders: Vec<i32>,
    /// The whole event is cancelled (`STATUS:CANCELLED`).
    pub cancelled: bool,
    pub extra: Vec<String>,
}

/// What reading an object left behind, for the import's report.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Notes {
    /// Zones read in the owner's zone because they were not recognised.
    pub unknown_zones: usize,
    /// Alarms beyond the first, or set at a fixed date or from the end.
    pub alarms_dropped: usize,
}

/// One calendar object, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Object {
    pub uid: String,
    /// `None` when the object holds only changed occurrences (an invitation to one date of somebody
    /// else's series).
    pub head: Option<Head>,
    pub overrides: Vec<Override>,
    pub notes: Notes,
}

/// Read a `VCALENDAR` text. `fallback_zone` is the owner's zone, for floating times and unknown
/// zone names. An error is a sentence for the import's report.
pub fn read(ics: &str, fallback_zone: &str) -> Result<Object, String> {
    // Clients end their lines as they please (CRLF, LF, a stray CR) and do not always end the last
    // one; a CalDAV server keeps the text as it came. One shape before reading.
    let mut normalized = ics
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim_end()
        .replace('\n', "\r\n");
    normalized.push_str("\r\n");
    let unfolded = unfold(&normalized);
    let calendar =
        read_calendar(&unfolded).map_err(|_| "not a readable iCalendar text".to_owned())?;
    let events: Vec<&Component> = calendar
        .components
        .iter()
        .filter(|c| c.name.as_str().eq_ignore_ascii_case("VEVENT"))
        .collect();
    if events.is_empty() {
        return Err("no event in this calendar object".to_owned());
    }
    let mut notes = Notes::default();
    let mut reader = Reader {
        fallback: fallback_zone,
        notes: &mut notes,
    };
    let uid = events
        .iter()
        .find_map(|e| value(e, "UID"))
        .unwrap_or_default();
    if uid.is_empty() {
        return Err("an event without a UID".to_owned());
    }
    let mut head = None;
    let mut overrides = Vec::new();
    for event in events {
        match event.find_prop("RECURRENCE-ID") {
            Some(property) => {
                let recurrence_id = reader.moment(property)?.recurrence_id();
                overrides.push(reader.occurrence(event, recurrence_id)?);
            }
            None if head.is_none() => head = Some(reader.head(event)?),
            None => return Err("two events share one UID without a RECURRENCE-ID".to_owned()),
        }
    }
    overrides.sort_by_key(|o| o.recurrence_id);
    Ok(Object {
        uid,
        head,
        overrides,
        notes,
    })
}

/// A moment as a property spells it.
#[derive(Debug, Clone, Copy)]
enum Moment {
    Date(Date),
    /// An instant, and the IANA zone it was written in.
    Instant(OffsetDateTime, &'static str),
}

impl Moment {
    fn recurrence_id(self) -> RecurrenceId {
        match self {
            Moment::Date(date) => RecurrenceId::Date(date),
            Moment::Instant(at, _) => RecurrenceId::Instant(at),
        }
    }
}

struct Reader<'a> {
    fallback: &'a str,
    notes: &'a mut Notes,
}

impl Reader<'_> {
    fn head(&mut self, event: &Component) -> Result<Head, String> {
        let (when, tzid) = self.when(event)?.ok_or("an event without a start")?;
        let rrule = value(event, "RRULE").filter(|r| !r.is_empty());
        if let Some(rule) = &rrule {
            recurrence::validate_rule(rule, recurrence::RuleOrigin::Import)
                .map_err(|e| e.to_string())?;
        }
        let mut rdates = Vec::new();
        for property in props(event, "RDATE") {
            for moment in self.moments(property)? {
                match (moment, &when) {
                    (Moment::Instant(at, _), _) => rdates.push(at),
                    (Moment::Date(date), When::AllDay { .. }) => {
                        rdates.push(date.midnight().assume_utc())
                    }
                    // A bare date added to a timed series names no time of day: left out.
                    (Moment::Date(_), When::Timed { .. }) => {}
                }
            }
        }
        let mut exdates = Vec::new();
        for property in props(event, "EXDATE") {
            exdates.extend(
                self.moments(property)?
                    .into_iter()
                    .map(Moment::recurrence_id),
            );
        }
        let organizer = event.find_prop("ORGANIZER").and_then(person);
        let attendees = props(event, "ATTENDEE")
            .filter_map(|p| {
                Some(Attendee {
                    person: person(p)?,
                    status: partstat(p),
                })
            })
            // The organiser is the author here, never on the list.
            .filter(|a| {
                organizer
                    .as_ref()
                    .is_none_or(|o| !o.email.eq_ignore_ascii_case(&a.person.email))
            })
            .collect();
        let reminders = self.reminders(event, matches!(when, When::AllDay { .. }));
        Ok(Head {
            title: text(event, "SUMMARY").unwrap_or_default(),
            description: text(event, "DESCRIPTION").filter(|t| !t.is_empty()),
            location: text(event, "LOCATION").filter(|t| !t.is_empty()),
            when,
            tzid,
            rrule,
            rdates,
            exdates,
            sequence: value(event, "SEQUENCE")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0),
            organizer,
            attendees,
            reminders,
            cancelled: is_cancelled(event),
            extra: extra(event),
        })
    }

    fn occurrence(
        &mut self,
        event: &Component,
        recurrence_id: RecurrenceId,
    ) -> Result<Override, String> {
        let when = self.when(event)?.map(|(when, _)| when);
        Ok(Override {
            recurrence_id,
            cancelled: is_cancelled(event),
            title: text(event, "SUMMARY"),
            description: text(event, "DESCRIPTION"),
            location: text(event, "LOCATION"),
            when,
            extra: extra(event),
        })
    }

    /// The event's time and zone: its start, and its end (or its duration, or the default length:
    /// one day for a date, none for an instant).
    fn when(&mut self, event: &Component) -> Result<Option<(When, Option<String>)>, String> {
        let Some(start) = event.find_prop("DTSTART") else {
            return Ok(None);
        };
        let start = self.moment(start)?;
        let end = match event.find_prop("DTEND") {
            Some(end) => Some(self.moment(end)?),
            None => None,
        };
        let length = value(event, "DURATION").and_then(|d| duration(&d));
        Ok(Some(match start {
            Moment::Date(start) => {
                let end = match end {
                    Some(Moment::Date(end)) if end > start => end,
                    _ => length
                        .filter(|l| l.whole_days() > 0)
                        .map(|l| start + Duration::days(l.whole_days()))
                        .unwrap_or(start + Duration::days(1)),
                };
                (When::AllDay { start, end }, None)
            }
            Moment::Instant(start, zone) => {
                let end = match end {
                    Some(Moment::Instant(end, _)) if end >= start => end,
                    _ => start + length.unwrap_or(Duration::ZERO),
                };
                (When::Timed { start, end }, Some(zone.to_owned()))
            }
        }))
    }

    fn moment(&mut self, property: &Property) -> Result<Moment, String> {
        self.moments(property)?
            .into_iter()
            .next()
            .ok_or_else(|| format!("an empty {}", property.name.as_str()))
    }

    /// Every moment of a property (`EXDATE` and `RDATE` may list several, comma separated).
    fn moments(&mut self, property: &Property) -> Result<Vec<Moment>, String> {
        let is_date = param(property, "VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE"));
        let zone = param(property, "TZID").map(|z| self.zone(&z));
        let mut found = Vec::new();
        for raw in property.val.as_str().split(',') {
            let raw = raw.trim();
            if raw.is_empty() {
                continue;
            }
            if is_date || raw.len() == 8 {
                found.push(Moment::Date(
                    parse_date(raw).ok_or_else(|| format!("an unreadable date: {raw}"))?,
                ));
                continue;
            }
            let (wall, utc) = match raw.strip_suffix('Z') {
                Some(wall) => (wall, true),
                None => (raw, false),
            };
            let (date, hour, minute, second) =
                parse_wall(wall).ok_or_else(|| format!("an unreadable time: {raw}"))?;
            if utc {
                found.push(Moment::Instant(
                    date.with_hms(hour, minute, second)
                        .map_err(|e| e.to_string())?
                        .assume_utc(),
                    "UTC",
                ));
                continue;
            }
            let zone = zone.unwrap_or_else(|| leak(self.fallback));
            let at = recurrence::local_instant(date, hour, minute, second, zone)
                .ok_or_else(|| format!("a time that does not exist in {zone}: {raw}"))?;
            found.push(Moment::Instant(at, zone));
        }
        Ok(found)
    }

    /// An IANA zone for a `TZID` as a client wrote it; the owner's when nothing matches.
    fn zone(&mut self, name: &str) -> &'static str {
        match resolve_zone(name) {
            Some(zone) => zone,
            None => {
                self.notes.unknown_zones += 1;
                leak(self.fallback)
            }
        }
    }

    /// The alarms set before the start, five at most, each at its own delay (a whole day's on the
    /// nearest the screen offers that reminds no later). Alarms after the start, at a fixed date or
    /// from the end, and the ones beyond five, are counted.
    fn reminders(&mut self, event: &Component, all_day: bool) -> Vec<i32> {
        let mut kept: Vec<i32> = Vec::new();
        for alarm in event
            .components
            .iter()
            .filter(|c| c.name.as_str().eq_ignore_ascii_case("VALARM"))
        {
            let minutes = alarm.find_prop("TRIGGER").and_then(|trigger| {
                let absolute =
                    param(trigger, "VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE-TIME"));
                let from_end =
                    param(trigger, "RELATED").is_some_and(|v| v.eq_ignore_ascii_case("END"));
                if absolute || from_end {
                    return None;
                }
                duration(trigger.val.as_str()).map(|d| -(d.whole_minutes() as i32))
            });
            let minutes = match minutes {
                Some(m) if all_day => Some(snap_all_day(m)),
                Some(m) if (0..=MAX_LEAD_MINUTES).contains(&m) => Some(m),
                _ => None,
            };
            match minutes {
                Some(m) if kept.contains(&m) => {}
                Some(m) if kept.len() < MAX_REMINDERS => kept.push(m),
                _ => self.notes.alarms_dropped += 1,
            }
        }
        kept
    }
}

/// A whole day's alarm, `minutes` before its local midnight, as the delay the screen offers that
/// reminds no later: the same morning at 9:00, the evening before at 17:00, or N days before at
/// 9:00 (28 at most).
pub fn snap_all_day(minutes: i32) -> i32 {
    if minutes <= 0 {
        return -540;
    }
    let choices = std::iter::once(420).chain((1..=28).map(|n| n * 1440 - 540));
    let mut last = 420;
    for choice in choices {
        if choice >= minutes {
            return choice;
        }
        last = choice;
    }
    last
}

/// An IANA zone for a name as a client wrote it: itself, the `Region/City` at the end of a path
/// (`/mozilla.org/20050126_1/Europe/Paris`), or the zone a Windows name stands for.
pub fn resolve_zone(name: &str) -> Option<&'static str> {
    let name = name.trim().trim_matches('"');
    let known = |candidate: &str| candidate.parse::<chrono_tz::Tz>().ok().map(|tz| tz.name());
    if let Some(zone) = known(name) {
        return Some(zone);
    }
    let parts: Vec<&str> = name.split('/').filter(|p| !p.is_empty()).collect();
    for from in 0..parts.len() {
        if let Some(zone) = known(&parts[from..].join("/")) {
            return Some(zone);
        }
    }
    WINDOWS_ZONES
        .iter()
        .find(|(windows, _)| windows.eq_ignore_ascii_case(name))
        .and_then(|(_, iana)| known(iana))
}

/// The owner's zone as a `'static` name, for the moments that fall back on it.
fn leak(zone: &str) -> &'static str {
    resolve_zone(zone).unwrap_or("UTC")
}

fn props<'a>(event: &'a Component, name: &'a str) -> impl Iterator<Item = &'a Property<'a>> {
    event
        .properties
        .iter()
        .filter(move |p| p.name.as_str().eq_ignore_ascii_case(name))
}

fn value(event: &Component, name: &str) -> Option<String> {
    props(event, name)
        .next()
        .map(|p| p.val.as_str().trim().to_owned())
}

/// A TEXT value, unescaped.
fn text(event: &Component, name: &str) -> Option<String> {
    props(event, name)
        .next()
        .map(|p| unescape(p.val.as_str()).trim().to_owned())
}

fn param(property: &Property, key: &str) -> Option<String> {
    property
        .params
        .iter()
        .find(|p| p.key.as_str().eq_ignore_ascii_case(key))
        .and_then(|p| p.val.as_ref())
        .map(|v| v.as_str().trim_matches('"').to_owned())
}

fn unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') | Some('N') => out.push('\n'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

fn is_cancelled(event: &Component) -> bool {
    value(event, "STATUS").is_some_and(|s| s.eq_ignore_ascii_case("CANCELLED"))
}

/// Somebody named by a `mailto:` address, with their `CN`.
fn person(property: &Property) -> Option<Person> {
    let raw = property.val.as_str().trim();
    let email = raw
        .get(..7)
        .filter(|scheme| scheme.eq_ignore_ascii_case("mailto:"))
        .map(|_| &raw[7..])?
        .trim()
        .to_lowercase();
    if !email.contains('@') {
        return None;
    }
    Some(Person {
        email,
        name: param(property, "CN").filter(|n| !n.trim().is_empty()),
    })
}

fn partstat(property: &Property) -> &'static str {
    match param(property, "PARTSTAT")
        .unwrap_or_default()
        .to_ascii_uppercase()
        .as_str()
    {
        "ACCEPTED" => "accepted",
        "TENTATIVE" => "tentative",
        "DECLINED" => "declined",
        _ => "needs_action",
    }
}

/// Every property Ruchoir does not read, as a content line (`NAME;PARAM=x:value`).
fn extra(event: &Component) -> Vec<String> {
    event
        .properties
        .iter()
        .filter(|p| {
            !HANDLED
                .iter()
                .any(|h| h.eq_ignore_ascii_case(p.name.as_str()))
        })
        .map(|p| {
            let mut line = p.name.as_str().to_owned();
            for parameter in &p.params {
                line.push(';');
                line.push_str(parameter.key.as_str());
                if let Some(v) = &parameter.val {
                    line.push('=');
                    line.push_str(v.as_str());
                }
            }
            line.push(':');
            line.push_str(p.val.as_str());
            line
        })
        .collect()
}

fn parse_date(raw: &str) -> Option<Date> {
    let year: i32 = raw.get(0..4)?.parse().ok()?;
    let month: u8 = raw.get(4..6)?.parse().ok()?;
    let day: u8 = raw.get(6..8)?.parse().ok()?;
    Date::from_calendar_date(year, time::Month::try_from(month).ok()?, day).ok()
}

/// `20261013T100000` as a date and a wall time.
fn parse_wall(raw: &str) -> Option<(Date, u8, u8, u8)> {
    let (date, clock) = raw.split_once(['T', 't'])?;
    let date = parse_date(date)?;
    let hour = clock.get(0..2)?.parse().ok()?;
    let minute = clock.get(2..4)?.parse().ok()?;
    let second = clock.get(4..6).and_then(|s| s.parse().ok()).unwrap_or(0);
    Some((date, hour, minute, second))
}

/// An iCalendar duration (`-PT15M`, `P1D`, `-P1DT2H`, `P1W`).
fn duration(raw: &str) -> Option<Duration> {
    let raw = raw.trim();
    let (negative, rest) = match raw.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, raw.strip_prefix('+').unwrap_or(raw)),
    };
    let rest = rest.strip_prefix('P')?;
    let mut total = Duration::ZERO;
    let mut number = String::new();
    let mut in_time = false;
    for c in rest.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' => number.push(c),
            unit => {
                let n: i64 = number.parse().ok()?;
                number.clear();
                total += match (unit, in_time) {
                    ('W', _) => Duration::weeks(n),
                    ('D', _) => Duration::days(n),
                    ('H', true) => Duration::hours(n),
                    ('M', true) => Duration::minutes(n),
                    ('S', true) => Duration::seconds(n),
                    _ => return None,
                };
            }
        }
    }
    if !number.is_empty() {
        return None;
    }
    Some(if negative { -total } else { total })
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::{date, datetime};

    fn wrap(body: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n{body}END:VCALENDAR\r\n")
    }

    #[test]
    fn a_weekly_series_in_paris_with_a_cancelled_and_a_moved_occurrence() {
        let ics = wrap(concat!(
            "BEGIN:VEVENT\r\n",
            "UID:series-1\r\n",
            "DTSTART;TZID=Europe/Paris:20261005T090000\r\n",
            "DTEND;TZID=Europe/Paris:20261005T094500\r\n",
            "SUMMARY:Point \u{e9}quipe\\, hebdo\r\n",
            "LOCATION:Salle Ouest\r\n",
            "RRULE:FREQ=WEEKLY;BYDAY=MO\r\n",
            "EXDATE;TZID=Europe/Paris:20261012T090000\r\n",
            "CATEGORIES:R\u{e9}union\r\n",
            "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT20M\r\nEND:VALARM\r\n",
            "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-P1D\r\nEND:VALARM\r\n",
            "END:VEVENT\r\n",
            "BEGIN:VEVENT\r\n",
            "UID:series-1\r\n",
            "RECURRENCE-ID;TZID=Europe/Paris:20261019T090000\r\n",
            "DTSTART;TZID=Europe/Paris:20261019T110000\r\n",
            "DTEND;TZID=Europe/Paris:20261019T114500\r\n",
            "SUMMARY:Point \u{e9}quipe (d\u{e9}cal\u{e9})\r\n",
            "END:VEVENT\r\n",
        ));
        let object = read(&ics, "UTC").expect("read");
        assert_eq!(object.uid, "series-1");
        let head = object.head.expect("head");
        assert_eq!(head.title, "Point \u{e9}quipe, hebdo");
        assert_eq!(head.tzid.as_deref(), Some("Europe/Paris"));
        assert_eq!(
            head.when,
            When::Timed {
                start: datetime!(2026-10-05 07:00 UTC),
                end: datetime!(2026-10-05 07:45 UTC),
            }
        );
        assert_eq!(head.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=MO"));
        // Every alarm before the start, at its own delay.
        assert_eq!(head.reminders, vec![20, 1440]);
        assert_eq!(object.notes.alarms_dropped, 0);
        assert_eq!(head.extra, vec!["CATEGORIES:R\u{e9}union".to_owned()]);
        assert_eq!(object.overrides.len(), 1);
        let moved = &object.overrides[0];
        assert_eq!(
            moved.recurrence_id,
            RecurrenceId::Instant(datetime!(2026-10-19 07:00 UTC))
        );
        assert_eq!(
            moved.when,
            Some(When::Timed {
                start: datetime!(2026-10-19 09:00 UTC),
                end: datetime!(2026-10-19 09:45 UTC),
            })
        );
        assert!(!moved.cancelled);
    }

    #[test]
    fn an_exdate_is_read_as_a_cancelled_date() {
        let ics = wrap(concat!(
            "BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261005T070000Z\r\nDTEND:20261005T080000Z\r\n",
            "RRULE:FREQ=DAILY;COUNT=5\r\nEXDATE:20261006T070000Z,20261007T070000Z\r\n",
            "SUMMARY:Daily\r\nEND:VEVENT\r\n",
        ));
        let head = read(&ics, "UTC").expect("read").head.unwrap();
        assert_eq!(head.tzid.as_deref(), Some("UTC"));
        assert_eq!(
            head.exdates,
            vec![
                RecurrenceId::Instant(datetime!(2026-10-06 07:00 UTC)),
                RecurrenceId::Instant(datetime!(2026-10-07 07:00 UTC)),
            ]
        );
    }

    #[test]
    fn a_whole_day_and_a_floating_time() {
        let day = read(
            &wrap("BEGIN:VEVENT\r\nUID:d\r\nDTSTART;VALUE=DATE:20261013\r\nSUMMARY:Off\r\nBEGIN:VALARM\r\nTRIGGER:-PT15H\r\nEND:VALARM\r\nEND:VEVENT\r\n"),
            "UTC",
        )
        .expect("read")
        .head
        .unwrap();
        assert_eq!(
            day.when,
            When::AllDay {
                start: date!(2026 - 10 - 13),
                end: date!(2026 - 10 - 14),
            }
        );
        // Fifteen hours before midnight: the day before at 9:00.
        assert_eq!(day.reminders, vec![900]);
        let floating = read(
            &wrap("BEGIN:VEVENT\r\nUID:f\r\nDTSTART:20261013T100000\r\nDURATION:PT1H\r\nSUMMARY:F\r\nEND:VEVENT\r\n"),
            "Europe/Paris",
        )
        .expect("read")
        .head
        .unwrap();
        assert_eq!(
            floating.when,
            When::Timed {
                start: datetime!(2026-10-13 08:00 UTC),
                end: datetime!(2026-10-13 09:00 UTC),
            }
        );
        assert_eq!(floating.tzid.as_deref(), Some("Europe/Paris"));
    }

    #[test]
    fn zones_written_another_way_are_brought_back() {
        assert_eq!(
            resolve_zone("/mozilla.org/20050126_1/Europe/Paris"),
            Some("Europe/Paris")
        );
        assert_eq!(resolve_zone("Romance Standard Time"), Some("Europe/Paris"));
        assert_eq!(resolve_zone("\"Europe/Berlin\""), Some("Europe/Berlin"));
        assert_eq!(resolve_zone("Somewhere/Nowhere"), None);
        let object = read(
            &wrap("BEGIN:VEVENT\r\nUID:z\r\nDTSTART;TZID=Custom Zone:20261013T100000\r\nSUMMARY:Z\r\nEND:VEVENT\r\n"),
            "Europe/Paris",
        )
        .expect("read");
        assert_eq!(object.notes.unknown_zones, 1);
        assert_eq!(object.head.unwrap().tzid.as_deref(), Some("Europe/Paris"));
    }

    #[test]
    fn people_and_their_answers() {
        let ics = wrap(concat!(
            "BEGIN:VEVENT\r\nUID:p\r\nDTSTART:20261013T080000Z\r\nDTEND:20261013T090000Z\r\n",
            "SUMMARY:Revue\r\n",
            "ORGANIZER;CN=Alice Martin:mailto:Alice@Example.org\r\n",
            "ATTENDEE;CN=Alice Martin;PARTSTAT=ACCEPTED:mailto:alice@example.org\r\n",
            "ATTENDEE;CN=Bob;PARTSTAT=DECLINED;ROLE=REQ-PARTICIPANT:mailto:bob@example.org\r\n",
            "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:client@outside.test\r\n",
            "ATTENDEE:urn:uuid:not-an-address\r\n",
            "END:VEVENT\r\n",
        ));
        let head = read(&ics, "UTC").expect("read").head.unwrap();
        assert_eq!(head.organizer.unwrap().email, "alice@example.org");
        assert_eq!(
            head.attendees
                .iter()
                .map(|a| (a.person.email.as_str(), a.status))
                .collect::<Vec<_>>(),
            vec![
                ("bob@example.org", "declined"),
                ("client@outside.test", "needs_action")
            ]
        );
        assert_eq!(head.attendees[0].person.name.as_deref(), Some("Bob"));
    }

    #[test]
    fn a_cancelled_occurrence_and_an_object_of_one_date_only() {
        let ics = wrap(concat!(
            "BEGIN:VEVENT\r\nUID:o\r\nRECURRENCE-ID;VALUE=DATE:20261014\r\nDTSTART;VALUE=DATE:20261014\r\n",
            "STATUS:CANCELLED\r\nSUMMARY:Gone\r\nEND:VEVENT\r\n",
        ));
        let object = read(&ics, "UTC").expect("read");
        assert!(object.head.is_none());
        assert!(object.overrides[0].cancelled);
        assert_eq!(
            object.overrides[0].recurrence_id,
            RecurrenceId::Date(date!(2026 - 10 - 14))
        );
    }

    #[test]
    fn what_cannot_be_read_says_why() {
        assert!(read("not ics", "UTC").is_err());
        assert!(read(&wrap("BEGIN:VTODO\r\nUID:t\r\nEND:VTODO\r\n"), "UTC").is_err());
        assert!(read(
            &wrap("BEGIN:VEVENT\r\nUID:r\r\nDTSTART:20261013T080000Z\r\nRRULE:FREQ=NEVER\r\nEND:VEVENT\r\n"),
            "UTC"
        )
        .is_err());
    }

    #[test]
    fn line_endings_as_clients_leave_them() {
        let body = "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:lf\nDTSTART:20261013T080000Z\nSUMMARY:Long\n  title\nEND:VEVENT\nEND:VCALENDAR";
        let head = read(body, "UTC")
            .expect("LF only, no final line break")
            .head
            .unwrap();
        assert_eq!(head.title, "Long title");
        let crlf = body.replace('\n', "\r\n") + "\r";
        assert!(
            read(&crlf, "UTC").is_ok(),
            "a lone carriage return at the end"
        );
    }

    #[test]
    fn durations_and_delays() {
        assert_eq!(duration("-PT15M"), Some(Duration::minutes(-15)));
        assert_eq!(duration("P1DT2H"), Some(Duration::hours(26)));
        assert_eq!(duration("P1W"), Some(Duration::weeks(1)));
        assert_eq!(duration("PX"), None);
        assert_eq!(snap_all_day(-60), -540);
        assert_eq!(snap_all_day(300), 420);
        assert_eq!(snap_all_day(900), 900);
        assert_eq!(snap_all_day(1000), 2340);
        assert_eq!(snap_all_day(100_000), 28 * 1440 - 540);
    }
}
