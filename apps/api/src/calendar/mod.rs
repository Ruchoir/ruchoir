//! The calendar: personal and space calendars, events and their recurring series, invitations and
//! their answers, reminders, and the read-only iCal subscription.
//!
//! A recurring event is stored the way iCalendar describes it, a rule and its exceptions, and its
//! occurrences are computed when they are asked for ([`recurrence`]). See
//! `docs/adr/0004-calendar-data-model.md` for why.

pub(crate) mod attachments;
pub(crate) mod attendees;
pub(crate) mod authz;
pub(crate) mod calendars;
pub(crate) mod dto;
pub(crate) mod error;
pub(crate) mod events;
pub(crate) mod feeds;
pub(crate) mod freebusy;
pub(crate) mod ics;
pub(crate) mod ics_import;
pub(crate) mod invitation_page;
pub(crate) mod invitations;
pub(crate) mod links;
pub(crate) mod occurrences;
pub(crate) mod recurrence;
pub(crate) mod reminders;
mod routes;
pub(crate) mod search;
pub(crate) mod typeset;

pub use routes::router;
