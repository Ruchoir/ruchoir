//! The words of a printed calendar, in the six languages, with no translation crate (as the mails in
//! `auth/mail_text.rs`): days, months, and the few phrases a page carries.

use time::{Date, Weekday};

use crate::auth::mail_text::Locale;

const WEEKDAYS: [[&str; 7]; 6] = [
    [
        "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche",
    ],
    [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    ],
    [
        "lunes",
        "martes",
        "miércoles",
        "jueves",
        "viernes",
        "sábado",
        "domingo",
    ],
    [
        "Montag",
        "Dienstag",
        "Mittwoch",
        "Donnerstag",
        "Freitag",
        "Samstag",
        "Sonntag",
    ],
    [
        "lunedì",
        "martedì",
        "mercoledì",
        "giovedì",
        "venerdì",
        "sabato",
        "domenica",
    ],
    [
        "poniedziałek",
        "wtorek",
        "środa",
        "czwartek",
        "piątek",
        "sobota",
        "niedziela",
    ],
];

const SHORT_WEEKDAYS: [[&str; 7]; 6] = [
    ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."],
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    ["lun.", "mar.", "mié.", "jue.", "vie.", "sáb.", "dom."],
    ["Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa.", "So."],
    ["lun", "mar", "mer", "gio", "ven", "sab", "dom"],
    ["pon.", "wt.", "śr.", "czw.", "pt.", "sob.", "niedz."],
];

const MONTHS: [[&str; 12]; 6] = [
    [
        "janvier",
        "février",
        "mars",
        "avril",
        "mai",
        "juin",
        "juillet",
        "août",
        "septembre",
        "octobre",
        "novembre",
        "décembre",
    ],
    [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ],
    [
        "enero",
        "febrero",
        "marzo",
        "abril",
        "mayo",
        "junio",
        "julio",
        "agosto",
        "septiembre",
        "octubre",
        "noviembre",
        "diciembre",
    ],
    [
        "Januar",
        "Februar",
        "März",
        "April",
        "Mai",
        "Juni",
        "Juli",
        "August",
        "September",
        "Oktober",
        "November",
        "Dezember",
    ],
    [
        "gennaio",
        "febbraio",
        "marzo",
        "aprile",
        "maggio",
        "giugno",
        "luglio",
        "agosto",
        "settembre",
        "ottobre",
        "novembre",
        "dicembre",
    ],
    [
        "styczeń",
        "luty",
        "marzec",
        "kwiecień",
        "maj",
        "czerwiec",
        "lipiec",
        "sierpień",
        "wrzesień",
        "październik",
        "listopad",
        "grudzień",
    ],
];

/// Polish names a month in the genitive after a day's number ("19 października").
const PL_MONTHS_OF: [&str; 12] = [
    "stycznia",
    "lutego",
    "marca",
    "kwietnia",
    "maja",
    "czerwca",
    "lipca",
    "sierpnia",
    "września",
    "października",
    "listopada",
    "grudnia",
];

fn row(locale: Locale) -> usize {
    match locale {
        Locale::Fr => 0,
        Locale::En => 1,
        Locale::Es => 2,
        Locale::De => 3,
        Locale::It => 4,
        Locale::Pl => 5,
    }
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// A weekday's short name, for a column head: "lun.".
pub fn short_weekday(locale: Locale, day: Weekday) -> &'static str {
    SHORT_WEEKDAYS[row(locale)][day.number_days_from_monday() as usize]
}

/// A month's name, as a heading: "Octobre".
pub fn month(locale: Locale, date: Date) -> String {
    capitalized(MONTHS[row(locale)][u8::from(date.month()) as usize - 1])
}

/// A month and its year, as a page's title: "Octobre 2026".
pub fn month_title(locale: Locale, date: Date) -> String {
    format!("{} {}", month(locale, date), date.year())
}

/// A day with its month, and its weekday and year when asked: "Lundi 19 octobre 2026".
pub fn long_date(locale: Locale, date: Date, weekday_too: bool, year_too: bool) -> String {
    let day = date.day();
    let index = u8::from(date.month()) as usize - 1;
    let month = MONTHS[row(locale)][index];
    let year = date.year();
    let core = match locale {
        Locale::De => format!("{day}. {month}"),
        Locale::Es => format!("{day} de {month}"),
        Locale::Pl => format!("{day} {}", PL_MONTHS_OF[index]),
        Locale::En | Locale::Fr | Locale::It => format!("{day} {month}"),
    };
    let core = match (year_too, locale) {
        (false, _) => core,
        (true, Locale::Es) => format!("{core} de {year}"),
        (true, _) => format!("{core} {year}"),
    };
    if !weekday_too {
        return core;
    }
    let name = WEEKDAYS[row(locale)][date.weekday().number_days_from_monday() as usize];
    let joined = match locale {
        Locale::De | Locale::Pl => format!("{name}, {core}"),
        _ => format!("{name} {core}"),
    };
    capitalized(&joined)
}

/// "Toute la journée": in place of a time.
pub fn all_day(locale: Locale) -> &'static str {
    match locale {
        Locale::Fr => "Toute la journée",
        Locale::En => "All day",
        Locale::Es => "Todo el día",
        Locale::De => "Ganztägig",
        Locale::It => "Tutto il giorno",
        Locale::Pl => "Cały dzień",
    }
}

/// "Aucun événement": a day or a period with nothing in it.
pub fn nothing(locale: Locale) -> &'static str {
    match locale {
        Locale::Fr => "Aucun événement",
        Locale::En => "No events",
        Locale::Es => "Ningún evento",
        Locale::De => "Keine Termine",
        Locale::It => "Nessun evento",
        Locale::Pl => "Brak wydarzeń",
    }
}

/// "Semaine du 19 octobre 2026": a week's title, from its first day.
pub fn week_title(locale: Locale, first: Date) -> String {
    let date = long_date(locale, first, false, true);
    match locale {
        Locale::Fr => format!("Semaine du {date}"),
        Locale::En => format!("Week of {date}"),
        Locale::Es => format!("Semana del {date}"),
        Locale::De => format!("Woche vom {date}"),
        Locale::It => format!("Settimana del {date}"),
        Locale::Pl => format!("Tydzień od {date}"),
    }
}

/// "+3 autres": what a full day of the month leaves out.
pub fn more(locale: Locale, count: usize) -> String {
    match locale {
        Locale::Fr => format!("+{count} autres"),
        Locale::En => format!("+{count} more"),
        Locale::Es => format!("+{count} más"),
        Locale::De => format!("+{count} weitere"),
        Locale::It => format!("+{count} altri"),
        Locale::Pl => format!("+{count} więcej"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    #[test]
    fn a_date_reads_as_each_language_writes_it() {
        let day = date!(2026 - 10 - 19);
        assert_eq!(
            long_date(Locale::Fr, day, true, true),
            "Lundi 19 octobre 2026"
        );
        assert_eq!(
            long_date(Locale::De, day, true, true),
            "Montag, 19. Oktober 2026"
        );
        assert_eq!(
            long_date(Locale::Es, day, true, true),
            "Lunes 19 de octubre de 2026"
        );
        assert_eq!(
            long_date(Locale::Pl, day, true, false),
            "Poniedziałek, 19 października"
        );
        assert_eq!(week_title(Locale::En, day), "Week of 19 October 2026");
        assert_eq!(month_title(Locale::It, day), "Ottobre 2026");
    }
}
