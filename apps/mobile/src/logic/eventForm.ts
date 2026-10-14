/**
 * The event form as data, with no React: a new event's draft or an existing one's, the end following
 * the start, and the `EventInput` the API takes. The rules are the web's (`EventForm.tsx`), so an
 * event made on the phone is the one the web would have made.
 *
 * Days are `YYYY-MM-DD`, times `HH:MM` on the wall clock of the draft's zone.
 */
import type { AttendeeStatus, Calendar, CalendarEvent, EventFile, EventInput, Occurrence } from "@ruchoir/client";
import {
  addDays,
  buildRule,
  formFor,
  localDay,
  localMinutes,
  movedSeriesStart,
  parseRule,
  presetOf,
  presetRule,
  zonedTime,
  type Preset,
  type RuleForm,
} from "@ruchoir/client/calendarLogic";

/** Someone on the list: an account, or an address only. */
export type DraftAttendee = { key: string; userId?: string; email?: string; name: string; status?: AttendeeStatus };

export type EventDraft = {
  title: string;
  calendarId: string;
  allDay: boolean;
  startDay: string;
  startTime: string;
  /** For a whole day, the last day (included). */
  endDay: string;
  endTime: string;
  tz: string;
  preset: Preset | "imported";
  custom: RuleForm;
  /** An untouched repetition is sent back exactly as it came. */
  ruleTouched: boolean;
  originalRule: string | null;
  /** The author's own reminders: `undefined` follows the calendar's. */
  reminders?: number[];
  remindersTouched: boolean;
  location: string;
  description: string;
  attendees: DraftAttendee[];
  attendeesTouched: boolean;
  channelId: string | null;
  channelTouched: boolean;
  files: EventFile[];
  filesTouched: boolean;
};

/** How long a new event lasts, in minutes: the web's default. */
export const DEFAULT_DURATION = 60;

export function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function minutesOf(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Where a new event goes first: the person's own calendar, else the first they may write in. */
export function defaultCalendarId(calendars: Calendar[]): string {
  const writable = calendars.filter((c) => c.canWriteEvents);
  return (writable.find((c) => !c.spaceId && !c.shareLevel) ?? writable[0])?.id ?? "";
}

/** A new event on `day`: today at the next full hour (23:00 at most), another day at 9:00. */
export function newDraft(o: {
  day: string;
  now: Date;
  timeZone: string;
  calendars: Calendar[];
  channelId?: string;
  duration?: number;
}): EventDraft {
  const duration = o.duration ?? DEFAULT_DURATION;
  const nowIso = o.now.toISOString();
  const today = localDay(nowIso, o.timeZone);
  const start = o.day === today ? Math.min(23 * 60, (Math.floor(localMinutes(nowIso, o.timeZone) / 60) + 1) * 60) : 9 * 60;
  return {
    title: "",
    calendarId: defaultCalendarId(o.calendars),
    allDay: false,
    startDay: o.day,
    startTime: hhmm(start),
    endDay: start + duration >= 1440 ? addDays(o.day, 1) : o.day,
    endTime: hhmm(start + duration),
    tz: o.timeZone,
    preset: "none",
    custom: formFor(null, o.day),
    ruleTouched: false,
    originalRule: null,
    reminders: undefined,
    remindersTouched: false,
    location: "",
    description: "",
    attendees: [],
    attendeesTouched: false,
    channelId: o.channelId ?? null,
    channelTouched: false,
    files: [],
    filesTouched: false,
  };
}

/** An existing event as the form shows it: the occurrence opened, in the event's own zone. */
export function draftFromEvent(occurrence: Occurrence, event: CalendarEvent, timeZone: string): EventDraft {
  const zone = occurrence.tzid ?? timeZone;
  const when = occurrence.allDay
    ? { startDay: occurrence.start, startTime: "09:00", endDay: addDays(occurrence.end, -1), endTime: "10:00" }
    : {
        startDay: localDay(occurrence.start, zone),
        startTime: hhmm(localMinutes(occurrence.start, zone)),
        endDay: localDay(occurrence.end, zone),
        endTime: hhmm(localMinutes(occurrence.end, zone)),
      };
  const rule = event.rrule ?? null;
  return {
    title: occurrence.title,
    calendarId: occurrence.calendarId,
    allDay: occurrence.allDay,
    ...when,
    tz: zone,
    preset: rule && !parseRule(rule) ? "imported" : presetOf(rule, when.startDay),
    custom: formFor(rule, when.startDay),
    ruleTouched: false,
    originalRule: rule,
    reminders: event.myOwnReminders,
    remindersTouched: false,
    location: occurrence.location ?? "",
    description: occurrence.description ?? "",
    attendees: event.attendees.map((a) => ({ key: a.id, userId: a.userId, email: a.email, name: a.name, status: a.status })),
    attendeesTouched: false,
    channelId: event.channel?.id ?? null,
    channelTouched: false,
    files: event.files,
    filesTouched: false,
  };
}

/** Another start day: the end day moves along. */
export function withStartDay(d: EventDraft, day: string): EventDraft {
  return { ...d, startDay: day, endDay: addDays(d.endDay, dayDiff(d.startDay, day)) };
}

/** Another start time: the end follows, keeping the length. */
export function withStartTime(d: EventDraft, next: string): EventDraft {
  const length = minutesOf(d.endTime) - minutesOf(d.startTime) + dayDiff(d.startDay, d.endDay) * 1440;
  const end = minutesOf(next) + Math.max(0, length);
  return { ...d, startTime: next, endDay: addDays(d.startDay, Math.floor(end / 1440)), endTime: hhmm(end) };
}

/** Another end time: within a day of the start, an end at or before the start runs past midnight. */
export function withEndTime(d: EventDraft, next: string): EventDraft {
  if (dayDiff(d.startDay, d.endDay) > 1) return { ...d, endTime: next };
  return { ...d, endTime: next, endDay: minutesOf(next) <= minutesOf(d.startTime) ? addDays(d.startDay, 1) : d.startDay };
}

/** The instants the event covers (a whole day from the midnights of its zone); `null` when its end is
 *  not after its start. */
export function draftSpan(d: EventDraft): { start: string; end: string } | null {
  const span = d.allDay
    ? { start: zonedTime(d.startDay, 0, d.tz), end: zonedTime(addDays(d.endDay, 1), 0, d.tz) }
    : { start: zonedTime(d.startDay, minutesOf(d.startTime), d.tz), end: zonedTime(d.endDay, minutesOf(d.endTime), d.tz) };
  return Date.parse(span.end) > Date.parse(span.start) ? span : null;
}

/** The repetition to send: as it came when untouched (or imported), else the one chosen. */
export function draftRule(d: EventDraft): string | null {
  if (!d.ruleTouched || d.preset === "imported") return d.originalRule;
  if (d.preset === "custom") {
    // The last second of a day in the event's zone, in UTC, as a timed rule's UNTIL writes it.
    const endOfDay = (day: string) =>
      new Date(Date.parse(zonedTime(addDays(day, 1), 0, d.tz)) - 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    return buildRule(d.custom, d.allDay, endOfDay, d.startDay);
  }
  return presetRule(d.preset, d.startDay);
}

export type DraftError = "titleRequired" | "endBeforeStart";

/**
 * What the API takes, or what stops it. On a change (`editing`), the attendees, the channel, the
 * files and the reminders are sent only when touched, so a change elsewhere leaves them as they are.
 */
export function toInput(d: EventDraft, editing: boolean): EventInput | { error: DraftError } {
  const title = d.title.trim();
  if (!title) return { error: "titleRequired" };
  const attendees =
    d.attendeesTouched || (!editing && d.attendees.length > 0)
      ? d.attendees.map((a) =>
          a.userId ? { userId: a.userId } : { email: a.email ?? a.name, ...(a.name && a.name !== (a.email ?? a.name) ? { name: a.name } : {}) },
        )
      : undefined;
  const base = {
    title,
    description: d.description.trim() || undefined,
    location: d.location.trim() || undefined,
    rrule: draftRule(d),
    attendees,
    ...(d.channelTouched || (!editing && d.channelId) ? { channelId: d.channelId } : {}),
    ...(d.filesTouched || (!editing && d.files.length > 0) ? { files: d.files.map((f) => f.id) } : {}),
    ...(d.remindersTouched && d.reminders !== undefined ? { reminders: d.reminders } : {}),
  };
  if (d.allDay) {
    if (d.endDay < d.startDay) return { error: "endBeforeStart" };
    return { ...base, allDay: true, start: d.startDay, end: addDays(d.endDay, 1) };
  }
  const start = zonedTime(d.startDay, minutesOf(d.startTime), d.tz);
  const end = zonedTime(d.endDay, minutesOf(d.endTime), d.tz);
  if (Date.parse(end) < Date.parse(start)) return { error: "endBeforeStart" };
  return { ...base, allDay: false, start, end, tzid: d.tz };
}

/**
 * A change made to a whole series from one of its dates: the series moves by as much as the date on
 * screen was moved (by wall clock, so it keeps its local time across a change of clock), and what
 * was not changed on screen keeps the series' own value (the date may have had its own).
 */
export function wholeSeriesInput(body: EventInput, occurrence: Occurrence, event: CalendarEvent, calendarId: string, tz: string): EventInput {
  const kept = (shown: string | undefined, own: string | undefined, series: string | undefined) => ((shown ?? "") === (own ?? "") ? series : shown);
  let whole: EventInput = {
    ...body,
    title: kept(body.title, occurrence.title, event.title) ?? body.title,
    location: kept(body.location, occurrence.location, event.location),
    description: kept(body.description, occurrence.description, event.description),
    calendarId: calendarId !== event.calendarId ? calendarId : undefined,
  };
  if (event.isRecurring && occurrence.recurrenceId) {
    if (body.allDay && event.allDay) {
      const start = addDays(event.start, dayDiff(occurrence.start, body.start));
      whole = { ...whole, start, end: addDays(start, dayDiff(body.start, body.end)) };
    } else if (!body.allDay && !event.allDay) {
      const length = Date.parse(body.end) - Date.parse(body.start);
      const start = movedSeriesStart(event.start, occurrence.start, body.start, body.tzid ?? tz);
      whole = { ...whole, start, end: new Date(Date.parse(start) + length).toISOString() };
    }
  }
  return whole;
}

/** Whether anything was changed since the form opened. */
export function isDirty(d: EventDraft, initial: EventDraft): boolean {
  return JSON.stringify(d) !== JSON.stringify(initial);
}
