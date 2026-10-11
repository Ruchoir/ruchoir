//! A printable calendar: the view on screen as an A4 PDF (landscape for a week, a month or a year),
//! in the reader's time zone and language, in their calendars' colours.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use sea_orm::EntityTrait;
use serde::Deserialize;
use serde_json::{json, Value};
use time::{Date, Duration, Month, OffsetDateTime, Weekday};
use uuid::Uuid;

use super::dto::OccurrenceDto;
use super::error::CalendarError;
use super::occurrences::{calendar_ids, gather};
use super::print_text as words;
use super::recurrence::{self, RecurrenceId};
use super::reminders::reader_time_zone;
use super::typeset;
use crate::auth::extract::AuthSession;
use crate::auth::mail_text::Locale;
use crate::entities::users;
use crate::state::AppState;

/// The template every view is laid out with.
const TEMPLATE: &str = include_str!("../../assets/print/calendar.typ");

/// The most events a day of the printed month lists before "+N more".
const MONTH_ENTRIES: usize = 4;

/// The calendars' pastels, as the screen paints them (`apps/web/app/tokens.css`). The accent, which
/// follows a person's theme on screen, prints as the default theme's sky.
fn colour(name: &str) -> &'static str {
    match name {
        "mint" => "#6fe0c2",
        "violet" => "#c9a8ff",
        "pink" => "#f5b0f0",
        "peach" => "#ffb3ba",
        "lime" => "#8fe6a3",
        "sun" => "#ffd84d",
        _ => "#8fd0ff",
    }
}

/// The colour invitations are drawn in, apart from any calendar.
const INVITATIONS: &str = "lime";

/// Which view to print.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrintView {
    Day,
    Week,
    Month,
    List,
    Year,
}

#[derive(Debug, Deserialize)]
pub struct PrintQuery {
    pub view: PrintView,
    /// A day of the period, `YYYY-MM-DD`: the day itself, its week, its month, the 30 days from
    /// it, or its year.
    pub date: String,
    /// Comma-separated calendar ids; every visible calendar when absent.
    pub calendars: Option<String>,
    /// Whether to add the events seen through an invitation alone; yes when absent.
    pub invitations: Option<bool>,
    /// The first day of a week, 0 for Sunday to 6 for Saturday; Monday when absent.
    pub week_start: Option<u8>,
}

/// The days a view covers: its first, and how many.
pub fn period(view: PrintView, day: Date, week_start: u8) -> (Date, i64) {
    let back = |d: Date| {
        let weekday = i64::from(d.weekday().number_days_from_sunday());
        d - Duration::days((weekday - i64::from(week_start)).rem_euclid(7))
    };
    match view {
        PrintView::Day => (day, 1),
        PrintView::Week => (back(day), 7),
        PrintView::List => (day, 30),
        PrintView::Month => {
            let first = day.replace_day(1).expect("the first of a month");
            let next = if first.month() == Month::December {
                Date::from_calendar_date(first.year() + 1, Month::January, 1)
            } else {
                Date::from_calendar_date(first.year(), first.month().next(), 1)
            }
            .expect("a month's first day");
            let start = back(first);
            let weeks = ((next - start).whole_days() + 6) / 7;
            (start, weeks * 7)
        }
        PrintView::Year => {
            let first = Date::from_calendar_date(day.year(), Month::January, 1).expect("1 January");
            let next =
                Date::from_calendar_date(day.year() + 1, Month::January, 1).expect("1 January");
            (first, (next - first).whole_days())
        }
    }
}

/// `GET /api/v1/calendar/print?view=&date=`: the view as a PDF.
#[utoipa::path(
    get,
    path = "/api/v1/calendar/print",
    tag = "calendar",
    params(
        ("view" = String, Query, description = "day, week, month, list or year"),
        ("date" = String, Query, description = "A day of the period, YYYY-MM-DD"),
        ("calendars" = Option<String>, Query, description = "Comma-separated calendar ids; all visible ones when absent"),
        ("invitations" = Option<bool>, Query, description = "Add the events seen through an invitation alone; yes when absent"),
        ("week_start" = Option<u8>, Query, description = "0 (Sunday) to 6; Monday when absent")
    ),
    responses(
        (status = 200, description = "An A4 PDF", content_type = "application/pdf"),
        (status = 422, description = "An unknown view or date")
    )
)]
pub async fn print(
    State(state): State<AppState>,
    session: AuthSession,
    Query(query): Query<PrintQuery>,
) -> Result<Response, CalendarError> {
    let format = time::macros::format_description!("[year]-[month]-[day]");
    let day = Date::parse(&query.date, &format)
        .map_err(|_| CalendarError::Invalid("A date is YYYY-MM-DD."))?;
    let week_start = query.week_start.unwrap_or(1);
    if week_start > 6 {
        return Err(CalendarError::Invalid(
            "A week starts on a day from 0 to 6.",
        ));
    }
    let reader = users::Entity::find_by_id(session.user_id)
        .one(&state.db)
        .await?;
    let zone = reader_time_zone(reader.as_ref());
    let locale = Locale::parse(reader.as_ref().and_then(|u| u.locale.as_deref()));
    let (first, days) = period(query.view, day, week_start);
    let bounds = |d: Date| {
        recurrence::local_midnight(d, &zone).ok_or(CalendarError::Invalid(
            "A date outside what the calendar reads.",
        ))
    };
    let (from, to) = (bounds(first)?, bounds(first + Duration::days(days))?);
    let wanted = calendar_ids(query.calendars.as_deref())?;
    let (found, accesses) = gather(
        &state.db,
        session.user_id,
        (from, to),
        wanted.as_ref(),
        query.invitations.unwrap_or(true),
    )
    .await?;
    let colours: HashMap<Uuid, &'static str> = accesses
        .values()
        .map(|a| (a.calendar.id, colour(&a.calendar.color)))
        .collect();
    let today = recurrence::local_parts(OffsetDateTime::now_utc(), &zone).map(|(d, _, _)| d);
    let data = document(
        &Page {
            view: query.view,
            first,
            days,
            day,
            week_start,
            locale,
            zone: &zone,
            today,
        },
        &found,
        &colours,
    );
    let pdf = tokio::task::spawn_blocking(move || typeset::pdf(TEMPLATE, &data))
        .await
        .map_err(|_| CalendarError::Internal)?
        .map_err(|error| {
            tracing::warn!(%error, "printing a calendar failed");
            CalendarError::Internal
        })?;
    let name = format!(
        "ruchoir-{}-{}.pdf",
        match query.view {
            PrintView::Day => "jour",
            PrintView::Week => "semaine",
            PrintView::Month => "mois",
            PrintView::List => "liste",
            PrintView::Year => "annee",
        },
        query.date
    );
    Ok((
        [
            (header::CONTENT_TYPE, "application/pdf".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
            (header::CACHE_CONTROL, "private, no-store".to_owned()),
        ],
        pdf,
    )
        .into_response())
}

/// What a page shows, and for whom.
pub struct Page<'a> {
    pub view: PrintView,
    pub first: Date,
    pub days: i64,
    /// The day asked for (the month of the month view, the year of the year view).
    pub day: Date,
    /// The first day of a week, 0 for Sunday.
    pub week_start: u8,
    pub locale: Locale,
    pub zone: &'a str,
    pub today: Option<Date>,
}

/// One occurrence on one day of the page.
struct Entry<'a> {
    occurrence: &'a OccurrenceDto,
    /// When on that day: "09:00 - 09:45", "Toute la journée", "→ 10:00".
    slot: String,
    /// The same, short, for a week's or a month's cell: "09:00", or nothing.
    time: String,
    /// What sorts a day's entries: whole days first, then by start.
    order: (u8, String),
}

fn hhmm(hour: u8, minute: u8) -> String {
    format!("{hour:02}:{minute:02}")
}

/// Each occurrence on each day it touches, in the reader's zone.
fn by_day<'a>(found: &'a [OccurrenceDto], page: &Page) -> HashMap<Date, Vec<Entry<'a>>> {
    let mut days: HashMap<Date, Vec<Entry<'a>>> = HashMap::new();
    for occurrence in found {
        // A declined invitation is not on the person's paper.
        if occurrence.my_status.as_deref() == Some("declined") {
            continue;
        }
        let parse = |text: &str| RecurrenceId::from_key(text);
        match (parse(&occurrence.start), parse(&occurrence.end)) {
            (Some(RecurrenceId::Date(start)), Some(RecurrenceId::Date(end))) => {
                let mut day = start;
                while day < end && (day - start).whole_days() < 366 {
                    days.entry(day).or_default().push(Entry {
                        occurrence,
                        slot: words::all_day(page.locale).to_owned(),
                        time: String::new(),
                        order: (0, String::new()),
                    });
                    day = day.next_day().expect("a next day");
                }
            }
            (Some(RecurrenceId::Instant(start)), Some(RecurrenceId::Instant(end))) => {
                let Some((first, h1, m1)) = recurrence::local_parts(start, page.zone) else {
                    continue;
                };
                let last_moment = if end > start {
                    end - Duration::seconds(1)
                } else {
                    end
                };
                let Some((last, _, _)) = recurrence::local_parts(last_moment, page.zone) else {
                    continue;
                };
                let (_, h2, m2) = recurrence::local_parts(end, page.zone).unwrap_or((last, h1, m1));
                let mut day = first;
                while day <= last && (day - first).whole_days() < 366 {
                    let (slot, time) = if first == last {
                        (format!("{} - {}", hhmm(h1, m1), hhmm(h2, m2)), hhmm(h1, m1))
                    } else if day == first {
                        (format!("{} →", hhmm(h1, m1)), hhmm(h1, m1))
                    } else if day == last {
                        (format!("→ {}", hhmm(h2, m2)), format!("→ {}", hhmm(h2, m2)))
                    } else {
                        (words::all_day(page.locale).to_owned(), String::new())
                    };
                    let order = if day == first {
                        (1, occurrence.start.clone())
                    } else {
                        (0, String::new())
                    };
                    days.entry(day).or_default().push(Entry {
                        occurrence,
                        slot,
                        time,
                        order,
                    });
                    day = day.next_day().expect("a next day");
                }
            }
            _ => {}
        }
    }
    for entries in days.values_mut() {
        entries.sort_by(|a, b| {
            a.order
                .cmp(&b.order)
                .then(a.occurrence.title.cmp(&b.occurrence.title))
        });
    }
    days
}

/// The data the template lays out for `page`.
pub fn document(
    page: &Page,
    found: &[OccurrenceDto],
    colours: &HashMap<Uuid, &'static str>,
) -> Value {
    let locale = page.locale;
    let mut by_day = by_day(found, page);
    let entry = |e: &Entry| {
        let o = e.occurrence;
        json!({
            "slot": e.slot,
            "time": e.time,
            "title": if o.busy { words::busy(locale) } else { o.title.as_str() },
            "place": o.location.as_deref().filter(|l| !l.trim().is_empty() && !o.busy),
            "color": if o.invited { colour(INVITATIONS) } else { colours.get(&o.calendar_id).copied().unwrap_or(colour("accent")) },
        })
    };
    let dates: Vec<Date> = (0..page.days)
        .map(|i| page.first + Duration::days(i))
        .collect();
    let opening = Weekday::Sunday.nth_next(page.week_start);
    let columns: Vec<&str> = (0..7)
        .map(|i| words::short_weekday(locale, opening.nth_next(i)))
        .collect();
    let title = match page.view {
        PrintView::Day => words::long_date(locale, page.first, true, true),
        PrintView::Week => words::week_title(locale, page.first),
        PrintView::Month => words::month_title(locale, page.day),
        PrintView::List => format!(
            "{} - {}",
            words::long_date(locale, page.first, false, true),
            words::long_date(
                locale,
                page.first + Duration::days(page.days - 1),
                false,
                true
            )
        ),
        PrintView::Year => page.day.year().to_string(),
    };
    let mut data = json!({
        "view": match page.view {
            PrintView::Day => "day",
            PrintView::Week => "week",
            PrintView::Month => "month",
            PrintView::List => "list",
            PrintView::Year => "year",
        },
        "landscape": matches!(page.view, PrintView::Week | PrintView::Month | PrintView::Year),
        "lang": match locale {
            Locale::Fr => "fr",
            Locale::En => "en",
            Locale::Es => "es",
            Locale::De => "de",
            Locale::It => "it",
            Locale::Pl => "pl",
        },
        "title": title,
        "nothing": words::nothing(locale),
        "columns": columns,
        "initials": columns.iter().map(|c| c.chars().next().map(|f| f.to_uppercase().to_string()).unwrap_or_default()).collect::<Vec<_>>(),
        "days": [],
        "months": [],
    });
    match page.view {
        PrintView::Day | PrintView::List | PrintView::Week | PrintView::Month => {
            // The list leaves out the days with nothing in them.
            let shown: Vec<Date> = dates
                .iter()
                .filter(|d| page.view != PrintView::List || by_day.contains_key(d))
                .copied()
                .collect();
            let days: Vec<Value> = shown
                .iter()
                .map(|d| {
                    let entries = by_day.remove(d).unwrap_or_default();
                    let label = match page.view {
                        PrintView::Week => {
                            format!("{} {}", words::short_weekday(locale, d.weekday()), d.day())
                        }
                        _ => words::long_date(locale, *d, true, false),
                    };
                    let (shown, more) =
                        if page.view == PrintView::Month && entries.len() > MONTH_ENTRIES {
                            // Room for one line less, to say how many are left out.
                            let kept = MONTH_ENTRIES - 1;
                            (
                                &entries[..kept],
                                Some(words::more(locale, entries.len() - kept)),
                            )
                        } else {
                            (&entries[..], None)
                        };
                    json!({
                        "label": label,
                        "number": d.day(),
                        "faint": page.view == PrintView::Month && d.month() != page.day.month(),
                        "today": Some(*d) == page.today,
                        "entries": shown.iter().map(entry).collect::<Vec<_>>(),
                        "more": more,
                    })
                })
                .collect();
            data["days"] = Value::Array(days);
        }
        PrintView::Year => {
            let months: Vec<Value> = (1..=12u8)
                .map(|m| {
                    let month = Month::try_from(m).expect("a month");
                    let first =
                        Date::from_calendar_date(page.day.year(), month, 1).expect("a first");
                    let blank = (i64::from(first.weekday().number_days_from_sunday())
                        - i64::from(page.week_start))
                    .rem_euclid(7);
                    let mut cells: Vec<Value> = (0..blank)
                        .map(|_| json!({ "number": null, "count": 0 }))
                        .collect();
                    let mut day = first;
                    while day.month() == month {
                        let count = by_day.get(&day).map_or(0, Vec::len);
                        cells.push(json!({ "number": day.day(), "count": count }));
                        match day.next_day() {
                            Some(next) => day = next,
                            None => break,
                        }
                    }
                    json!({ "name": words::month(locale, first), "cells": cells })
                })
                .collect();
            data["months"] = Value::Array(months);
        }
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    fn occurrence(title: &str, start: &str, end: &str, all_day: bool) -> OccurrenceDto {
        OccurrenceDto {
            event_id: Uuid::nil(),
            calendar_id: Uuid::nil(),
            recurrence_id: None,
            title: title.to_owned(),
            location: Some("Salle Ouest".to_owned()),
            description: None,
            all_day,
            start: start.to_owned(),
            end: end.to_owned(),
            tzid: Some("Europe/Paris".to_owned()),
            is_recurring: false,
            overridden: false,
            can_edit: true,
            my_reminders: Vec::new(),
            my_status: None,
            invited: false,
            has_attendees: false,
            busy: false,
        }
    }

    fn page(view: PrintView, day: Date) -> Page<'static> {
        let (first, days) = period(view, day, 1);
        Page {
            view,
            first,
            days,
            day,
            week_start: 1,
            locale: Locale::Fr,
            zone: "Europe/Paris",
            today: None,
        }
    }

    fn found() -> Vec<OccurrenceDto> {
        vec![
            occurrence(
                "Point *équipe* #1 [a] $b$ \\ <c>",
                "2026-10-19T07:00:00Z",
                "2026-10-19T07:45:00Z",
                false,
            ),
            occurrence("Séminaire", "2026-10-21", "2026-10-23", true),
            occurrence(
                "Garde de nuit",
                "2026-10-23T20:00:00Z",
                "2026-10-24T05:00:00Z",
                false,
            ),
        ]
    }

    #[test]
    fn every_page_carries_the_ruchoir_mark() {
        use typst::layout::{Frame, FrameItem};
        fn images(frame: &Frame) -> usize {
            frame
                .items()
                .map(|(_, item)| match item {
                    FrameItem::Group(group) => images(&group.frame),
                    FrameItem::Image(..) => 1,
                    _ => 0,
                })
                .sum()
        }
        let data = document(
            &page(PrintView::Month, date!(2026 - 10 - 19)),
            &found(),
            &HashMap::new(),
        );
        let laid = typeset::layout(TEMPLATE, &data).expect("laid out");
        assert_eq!(images(&laid.pages()[0].frame), 1);
        assert!(typeset::printed(&laid).contains("Ruchoir"));
    }

    #[test]
    fn a_long_list_carries_the_mark_on_its_next_pages_too() {
        use typst::layout::{Frame, FrameItem};
        fn images(frame: &Frame) -> usize {
            frame
                .items()
                .map(|(_, item)| match item {
                    FrameItem::Group(group) => images(&group.frame),
                    FrameItem::Image(..) => 1,
                    _ => 0,
                })
                .sum()
        }
        let many: Vec<OccurrenceDto> = (0..60)
            .map(|i| {
                let day = 1 + i % 28;
                occurrence(
                    &format!("Rendez-vous {i}"),
                    &format!("2026-11-{day:02}T08:00:00Z"),
                    &format!("2026-11-{day:02}T09:00:00Z"),
                    false,
                )
            })
            .collect();
        let data = document(
            &page(PrintView::List, date!(2026 - 11 - 01)),
            &many,
            &HashMap::new(),
        );
        let laid = typeset::layout(TEMPLATE, &data).expect("laid out");
        assert!(laid.pages().len() > 1);
        for page in laid.pages() {
            assert_eq!(images(&page.frame), 1);
        }
    }

    #[test]
    fn a_busy_block_prints_as_busy() {
        let mut block = occurrence("", "2026-10-19T12:00:00Z", "2026-10-19T13:00:00Z", false);
        block.busy = true;
        block.location = None;
        let data = document(
            &page(PrintView::Day, date!(2026 - 10 - 19)),
            &[block],
            &HashMap::new(),
        );
        let text = typeset::printed(&typeset::layout(TEMPLATE, &data).expect("laid out"));
        assert!(text.contains("Occupé"), "{text}");
    }

    #[test]
    fn a_period_follows_its_view() {
        assert_eq!(
            period(PrintView::Week, date!(2026 - 10 - 21), 1),
            (date!(2026 - 10 - 19), 7)
        );
        assert_eq!(
            period(PrintView::Week, date!(2026 - 10 - 21), 0),
            (date!(2026 - 10 - 18), 7)
        );
        // October 2026 starts on a Thursday and ends on a Saturday: five weeks from Monday 28 Sept.
        assert_eq!(
            period(PrintView::Month, date!(2026 - 10 - 21), 1),
            (date!(2026 - 09 - 28), 35)
        );
        assert_eq!(
            period(PrintView::Year, date!(2028 - 06 - 01), 1),
            (date!(2028 - 01 - 01), 366)
        );
        assert_eq!(
            period(PrintView::List, date!(2026 - 10 - 21), 1),
            (date!(2026 - 10 - 21), 30)
        );
    }

    #[test]
    fn every_view_prints_what_happens_with_typed_signs_as_typed() {
        for view in [
            PrintView::Day,
            PrintView::Week,
            PrintView::Month,
            PrintView::List,
            PrintView::Year,
        ] {
            let data = document(
                &page(view, date!(2026 - 10 - 19)),
                &found(),
                &HashMap::new(),
            );
            let laid = typeset::layout(TEMPLATE, &data).unwrap_or_else(|e| panic!("{view:?}: {e}"));
            let text: String = typeset::printed(&laid).split_whitespace().collect();
            if view != PrintView::Year {
                assert!(
                    text.contains("Point*équipe*#1[a]$b$\\<c>"),
                    "{view:?}: {text}"
                );
            }
            assert!(typeset::pdf(TEMPLATE, &data)
                .expect("pdf")
                .starts_with(b"%PDF-"));
        }
    }

    #[test]
    fn a_day_lists_times_and_places_and_says_when_it_is_empty() {
        let data = document(
            &page(PrintView::Day, date!(2026 - 10 - 19)),
            &found(),
            &HashMap::new(),
        );
        let text = typeset::printed(&typeset::layout(TEMPLATE, &data).expect("laid out"));
        assert!(text.contains("Lundi 19 octobre 2026"), "{text}");
        assert_eq!(text.matches("Lundi 19 octobre").count(), 1, "{text}");
        assert!(text.contains("09:00 - 09:45"), "{text}");
        assert!(text.contains("Salle Ouest"), "{text}");
        let data = document(
            &page(PrintView::Day, date!(2026 - 10 - 20)),
            &found(),
            &HashMap::new(),
        );
        let text = typeset::printed(&typeset::layout(TEMPLATE, &data).expect("laid out"));
        assert!(text.contains("Aucun événement"), "{text}");
    }

    #[test]
    fn a_whole_day_and_a_night_show_on_each_day_they_touch() {
        let data = document(
            &page(PrintView::Week, date!(2026 - 10 - 19)),
            &found(),
            &HashMap::new(),
        );
        let days = data["days"].as_array().expect("days");
        let titles = |i: usize| -> Vec<String> {
            days[i]["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["title"].as_str().unwrap().to_owned())
                .collect()
        };
        assert_eq!(titles(2), vec!["Séminaire"]);
        assert_eq!(titles(3), vec!["Séminaire"]);
        assert!(titles(4).contains(&"Garde de nuit".to_owned()));
        assert_eq!(titles(5), vec!["Garde de nuit"]);
        assert_eq!(days[5]["entries"][0]["time"], "→ 07:00");
    }

    #[test]
    fn a_full_day_of_the_month_says_how_many_it_leaves_out() {
        let many: Vec<OccurrenceDto> = (0..6)
            .map(|i| {
                occurrence(
                    &format!("Rendez-vous {i}"),
                    &format!("2026-10-20T0{i}:00:00Z"),
                    &format!("2026-10-20T0{i}:30:00Z"),
                    false,
                )
            })
            .collect();
        let data = document(
            &page(PrintView::Month, date!(2026 - 10 - 20)),
            &many,
            &HashMap::new(),
        );
        let day = data["days"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["number"] == 20 && d["faint"] == false)
            .expect("the 20th");
        assert_eq!(day["entries"].as_array().unwrap().len(), 3);
        assert_eq!(day["more"], "+3 autres");
    }

    #[test]
    fn the_year_marks_busy_days_from_the_week_start() {
        let data = document(
            &page(PrintView::Year, date!(2026 - 10 - 19)),
            &found(),
            &HashMap::new(),
        );
        let october = &data["months"][9];
        // 1 October 2026 is a Thursday: three blanks before it from Monday.
        assert_eq!(october["cells"][3]["number"], 1);
        assert_eq!(october["cells"][2]["number"], Value::Null);
        assert_eq!(october["cells"][3 + 18]["count"], 1);
    }
}
