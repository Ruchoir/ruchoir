# The calendar

Personal and space calendars, events and recurring series, reminders, and a read-only iCal
subscription. Why recurring events are stored the way they are: [ADR 0004](adr/0004-calendar-data-model.md).

## Calendars and who does what

- **A personal calendar** belongs to one person and nobody else sees it. Everyone has one ("Personnel",
  named in their language, in the colour `accent`: each viewer's own theme accent), created the
  first time they open the calendar, and may make more.
- **A space calendar** is seen by the space's members (`member`, `admin`, `owner`); a guest sees none.
  Each space starts with one, named after the space (it follows a rename of the space until someone
  names it otherwise), in the colour its creator uses least among their spaces, so two spaces rarely
  look alike. Its administrators make more,
  rename, recolour and delete them, and choose for each **who adds events**: every member, or
  administrators only.
- A calendar someone cannot see answers `404`, exactly like one that does not exist. A space's first
  calendar and a person's are renamed but never deleted; deleting any other one asks for its name.
- Visibility is computed from membership on every request: leaving a space takes its calendars, their
  subscription addresses and their reminders away at once.

Colours are the design system's pastels (`sky`, `mint`, `violet`, `pink`, `peach`, `lime`, `sun`), with
the dark ink on them in every theme.

## Events and series

- A timed event is two instants and the IANA time zone it was written in; an all-day event is two
  dates, the end exclusive (one day on the 7th ends on the 8th) and in no time zone.
- A repetition is an RFC 5545 rule. The screen writes daily, weekly (chosen days), monthly (the
  start's day, "the 2nd Thursday", the last working day) and yearly rules, every N, ending never,
  after N times or on a date; any rule read from elsewhere is kept and shown as "custom rule
  (imported)".
- Changing or deleting an occurrence of a series asks: **this one** (an exception), **this one and the
  following ones** (the series is cut in two), or **the whole series** (when its timing changes, the
  occurrences that had only been moved go back to the series and the cancellations stay).

The API: `GET /api/v1/calendars`, `GET /api/v1/calendar/occurrences?from&to&calendars=` (at most 400
days), `POST /api/v1/calendars/{id}/events`, `GET|PATCH|DELETE /api/v1/events/{id}?scope=&recurrence_id=`,
and each viewer's own settings at `PUT /api/v1/calendars/{id}/me` and `PUT /api/v1/events/{id}/me`.
The OpenAPI document has the details. Every change publishes `calendar.changed` to the calendar's
audience, and open screens reload.

## Sharing a personal calendar

- Its owner shares it from its settings with people they have **a space in common** with, at one of
  three levels (`calendar_shares`): **free/busy only** (busy blocks, without title, place or notes,
  that do not open), **see details** (as an invitee reads an event), **edit events** (create,
  change, delete them; the author stays whoever created each). Only the owner manages the calendar
  and its shares (`/api/v1/calendars/{id}/shares`, `share-candidates`); a change takes effect at
  once, and opening a share tells the person in the app (`calendar_shared`, never by mail).
- The person finds it under "Shared with me", by whose it is, and may hide it.
- A share holds while the two people have a space in common: checked on every read, so leaving the
  last common space ends it with nothing to clean up. It goes with the calendar or either account.
- `calendar::authz::access` grants "see details" and "edit events" only, so every route about one
  event (details, answers, files, channel links) refuses a free/busy share by construction; the
  lists (`visible`) carry it with a busy flag: occurrences come as blocks, search leaves the
  calendar out, the PDF prints "Busy", and the feed of all one's calendars writes busy blocks with
  nothing but their times. An event of that calendar the person is invited to still reads in full.
- Shared calendars are not reminded to their readers (the owner is), and free/busy blocks count when
  looking for a free slot like everything else in the owner's day.

## Reminders

- A reminder belongs to a person, not to an event. Who gets one: the owner of a personal calendar;
  every member who sees a space calendar; for an event with attendees, see Invitations below.
- Each calendar has **default reminders** for its timed events (10 minutes for the first ones; none
  is a valid choice, for a leave calendar say). Each person may choose their own for a whole calendar
  or for one event. An all-day event reminds only who asked (the evening before at 17:00, the same
  morning at 9:00, or N days before at 9:00, in their profile's time zone).
- **Up to five** reminders each time, each delay once: the usual ones (at the start, 5, 10, 15, 30
  minutes, an hour, a day) or one's own, up to four weeks before. A delay is stored in minutes before
  the start; for a whole day, before the local midnight that starts it (`420` the evening before at
  17:00, `-540` the same morning at 9:00, `N * 1440 - 540` N days before at 9:00, N from 1 to 28).
  An empty list means no reminder; no choice at all means "as the calendar".
- `apps/api/src/calendar/reminders.rs` sweeps every minute. A reminder due in the last fifteen minutes
  goes out; a later one (the server was down) is dropped rather than sent at the wrong moment. A log
  (`calendar_reminder_deliveries`, keyed by person, event, occurrence and delay) makes sure no
  reminder goes out twice, even with two API processes.
- It lands in the notification inbox (and by Web Push, like any notification), and by **mail** to
  whoever has no Ruchoir open, when the instance has a mail relay. Quiet hours and "do not disturb"
  hold back the push and the mail; the inbox keeps it. The preferences have a "Calendar reminders"
  row, for the app and for mail.

## Invitations

- **Who may be invited.** To an event of a space calendar: the space's members who see its calendars
  (`member`, `admin`, `owner`; never a guest). To an event of a personal calendar: anyone sharing a
  space with its owner. And anyone by email address; an address that is such a member becomes them.
  Whoever may write in the calendar changes the list, which belongs to the series (and follows it
  when "this and the following ones" splits it). The organiser is the event's author, off the list,
  counted as going. 100 attendees at most.
- **Answers**: yes, maybe, no, for the series or for one date of it (`calendar_attendee_overrides`);
  answering for the series again clears the dates' own answers. Members answer in the event's details
  or from the notification; people invited by address on a public page, `/i/?t=<token>`, for every
  date. Their token is found by its digest and also kept encrypted with the server's key
  (`RUCHOIR_SECRET_ENCRYPTION_KEY`), so every later mail repeats the same link.
- **Seeing an invitation.** Someone invited to an event of a calendar they do not see (someone's
  personal one) sees that event, read only, as long as they share a space with its owner. The
  screen gathers those under an "Invitations received" calendar of theirs, which they may hide.
- **Reminders.** An event with attendees reminds its organiser and the attendees who still may be
  invited and did not decline (that date); without attendees nothing changes.
- **Telling people** (`apps/api/src/calendar/invitations.rs`): an invitation, a change of time or
  place (to those who did not decline), a cancellation or being taken off the list, and a refusal
  (to the organiser only). Members get a notification (`calendar_invitation`, `calendar_update`,
  `calendar_cancel`, `calendar_declined`), pushed, and a mail when no Ruchoir page is open and the
  "Calendar invitations" preference allows it. People invited by address get a mail in the
  organiser's language with the event attached (`METHOD:REQUEST`, or `CANCEL`). Nobody is told of
  their own doing. A notification keeps the event as it was (`notifications.payload`), so a
  cancellation outlives its event.
- **Free/busy**: `POST /api/v1/calendar/freebusy` gives people's busy times (merged, never a title)
  over 31 days at most, for people sharing a space with the caller. Busy means one's own calendars,
  the events one is invited to and did not decline, and those one organises with attendees; a space
  event that asks nothing of anyone keeps nobody busy. The form shows a line per person on the
  event's day and proposes slots when everyone is free ("Find a time").
- **The feed** names each event's organiser and attendees (a member by `urn:uuid:`, never their
  address), and the address for all of someone's calendars carries their invitations.

API: `attendees` in the event body (the whole list; absent leaves it), `organizer`, `attendees` and
`my_status` on an event, `my_status`, `invited` and `has_attendees` on an occurrence,
`PUT /api/v1/events/{id}/response`, `GET /api/v1/calendars/{id}/invitees?q=`,
`POST /api/v1/calendar/freebusy`, `GET|POST /api/v1/public/invitation/{token}`.

## Channels and attached files

- **A linked channel.** An event may be linked to one channel: for a space calendar, a public channel
  of the space or a private one its author is in; for a personal calendar, such a channel of any of
  the author's spaces (`GET /api/v1/calendars/{id}/channels`). Never a direct message. The link
  belongs to the series. Whoever reads the channel sees the event, read only, like an invitee;
  someone who sees the event without reading a private linked channel sees "Private channel", with
  no name and no way in.
- **Cards** (`apps/api/src/calendar/links.rs`): linking a channel posts a system message
  `calendar_event_posted` there, pointing at the event (`messages.event_id`); a new time or place
  adds `calendar_event_changed`, a deletion of the whole event `calendar_event_cancelled` (its title
  kept in the body, the event being gone). A message carries `event`, the event as its reader sees
  it now: its next date, where, the organiser, and the reader's answer, which an invitee gives from
  the card for every date. A card that arrives live carries nobody's answer: the screen reads the
  reader's own from the event.
- **Upcoming**: a channel shows its next three linked occurrences, within two months, under its
  header (`GET /api/v1/channels/{id}/events`).
- **Invite the whole channel** adds the channel's members who may be invited
  (`GET /api/v1/calendars/{id}/invitees?channel=`). **Plan an event**, in a channel's menu, opens the
  form already linked to it, in the space's default calendar when the viewer may write there.
- **Attached files** (`apps/api/src/calendar/attachments.rs`): up to 20 files of a space's tree
  (never a folder, never a private conversation's attachment) that the author may read, taken from a
  Drive or dropped from the device into the space's "Agenda" folder (created on first use, found by
  its system key; for a personal calendar, the space of the linked channel). The list belongs to the
  series and is replaced whole. **The event gives access to its files**: whoever sees it may read
  them (download and preview, never edit, `FileAccess.through_event`), and taking a file off the
  event takes that access away; the file stays in the Drive. People invited by address download them
  from their answer page.

API: `channel_id` (absent leaves it, `null` unlinks) and `files` (the whole list of ids) in the
event body; `channel` and `files` on an event; `event` on a message;
`GET /api/v1/calendars/{id}/attachment-folder?channel=`,
`GET /api/v1/public/invitation/{token}/files/{file_id}`.

## The screen

- **The column** (desktop and tablet, in place of the space's) lists the viewer's calendars in three
  blocks: their own, the space the screen was opened from, and their other spaces, one line per space
  (a space with several calendars unfolds them), folded on demand and searchable beyond six spaces.
- **The filter** never grows with the number of spaces: "This space" or "All my spaces" when the
  screen was opened from a space, a searchable list of spaces from the phone's tab.
- **New events** start from a small bubble beside the slot clicked (title, times, calendar), which
  opens into the full window; the window is laid out not to scroll, and the custom repetition takes
  its place while it is set. The calendar is chosen from a list laid out as the column is (the
  viewer's own, the current space, the others), with colours and a search. Hovering an empty slot
  shows what a click would create. Every form warns
  (without refusing) when the event overlaps another one, in any calendar the viewer sees.
- **The theme's accent** marks what is chosen: the view, the filter, today, and what the small month
  shows (a faint band for the week on screen, a faint pill for a single day).
- **The year** shows twelve small months: a dot on a day with events, a filled mark beyond three,
  today in red. A day opens the day view, a month's name the month view; on a phone it opens on the
  current month.
- **Searching** (the magnifier in the bar, and the "Events" section of the global search, Ctrl+K):
  `GET /api/v1/calendar/search?q=` reads the title, place and notes of every event the viewer sees
  (their calendars, their spaces', their invitations), its guests' names and addresses, and the dates
  of a series changed alone, case and accents aside; `%` and `_` are looked for as typed. Each event
  comes once: the coming ones on their next date, soonest first, then the past ones on their last,
  latest first (a series found by one changed date comes on that date); fifty at most. A result
  opens the event at its date.
- **Printing** (the printer in the bar): `GET /api/v1/calendar/print?view=&date=` turns the view on
  screen into an A4 PDF (landscape for a week, a month or a year), with the same calendars and
  invitations, in the reader's time zone, language and first day of the week, in the calendars'
  colours, with the Ruchoir mark on each page. The week prints as seven columns, the month as its
  grid (four events a day, then "+N more"), the year as twelve small months. A declined invitation
  is left off. It is typeset inside the API by Typst (`calendar/typeset.rs`, template
  `apps/api/assets/print/calendar.typ`), with IBM Plex Sans embedded; what people typed reaches the
  template as JSON data, never as markup.
- **Preferences > Calendar** (kept on the device, like the other preferences, in
  `features/calendar/prefs.ts`): the view it opens on (computer and phone apart), the first day of the
  week, the clock (as the language writes it, 24 or 12 hours), the weekend in the week view, week
  numbers, the hour the grid opens at, the working hours (off by default; once on, the others are
  greyed), and how long a new event lasts.

## Subscribing from a phone

Each person can make a **personal address** for one calendar, or one address for all of them:
`https://<instance>/api/v1/public/ical/<token>.ics`. It is read without a session, so the token is
the whole credential: it is shown once, only its digest is kept, it can be revoked, and requests are
rate-limited per address (two phones behind one network do not share a limit). The file carries
the rules, the cancellations and the changed occurrences, a `VTIMEZONE` for every zone in use, the
calendar's name and colour, and a `VALARM` for each of the reader's reminders.

To add it: on an iPhone, Settings > Calendar > Accounts > Add Account > Other > Add Subscribed
Calendar; on Android, an app that reads iCal subscriptions (ICSx⁵, for example); in Thunderbird,
New Calendar > On the Network.

## Coming from Nextcloud or Teams

The Nextcloud producer (`packages/importer/export-nextcloud.sh`) exports every calendar holding
events, and the Teams reader (`packages/importer/convert-teams.py --with-calendars`) each person's
own Outlook calendars. The import brings each one in as a **personal calendar of its owner**, with
its events, their series and exceptions, attendees and answers (silently), and the alarms set
before the start as the owner's reminders (five at most, at their exact delay). Shares, task lists, the contact birthdays calendar, the calendar trash,
subscriptions to outside calendars and Teams' team calendars stay behind, named in the archive's
limits. The format and the rules are in
`docs/import-archive.md`, section "Calendars".

## Limits of this first lot

Not yet: two-way sync with other calendars (CalDAV).
