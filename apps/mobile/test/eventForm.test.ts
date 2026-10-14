import { test } from "node:test";
import assert from "node:assert/strict";

import type { Calendar, CalendarEvent, Occurrence } from "@ruchoir/client";

import {
  defaultCalendarId,
  draftFromEvent,
  newDraft,
  phoneFilesNeedChannel,
  setWhen,
  toInput,
  wholeSeriesInput,
  withEndTime,
  withStartTime,
  type EventDraft,
} from "../src/logic/eventForm.ts";

const PARIS = "Europe/Paris";

const calendar = (id: string, extra: Partial<Calendar> = {}): Calendar => ({
  id,
  name: id,
  color: "sky",
  writeAccess: "members",
  defaultReminders: [],
  isDefault: false,
  canWriteEvents: true,
  canManage: true,
  hidden: false,
  ...extra,
});

const OWN = calendar("own");
const SPACE = calendar("space", { spaceId: "s1" });
const SHARED = calendar("shared", { shareLevel: "write", ownerName: "Léa" });

const draft = (o: Partial<Parameters<typeof newDraft>[0]> = {}): EventDraft =>
  newDraft({ day: "2026-10-14", now: new Date("2026-10-14T08:20:00Z"), timeZone: PARIS, calendars: [OWN], ...o });

const occurrence = (extra: Partial<Occurrence> = {}): Occurrence => ({
  eventId: "e1",
  calendarId: "own",
  title: "Réunion",
  allDay: false,
  start: "2026-10-14T09:00:00Z",
  end: "2026-10-14T10:00:00Z",
  tzid: PARIS,
  isRecurring: false,
  overridden: false,
  canEdit: true,
  myReminders: [],
  invited: false,
  hasAttendees: true,
  busy: false,
  ...extra,
});

const event = (o: Occurrence, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  ...o,
  updatedAt: "2026-10-01T00:00:00Z",
  attendees: [{ id: "a1", userId: "u1", name: "Léa", status: "accepted" }],
  channel: { id: "ch1", name: "équipe", spaceId: "s1", private: false, accessible: true },
  files: [{ id: "f1", name: "plan.pdf", size: 10 }],
  myOwnReminders: [15],
  ...extra,
});

test("new_draft_today_starts_at_next_full_hour", () => {
  const d = draft();
  assert.equal(d.startDay, "2026-10-14");
  assert.equal(d.startTime, "11:00");
  assert.equal(d.endDay, "2026-10-14");
  assert.equal(d.endTime, "12:00");
  assert.equal(d.tz, PARIS);
  assert.equal(d.allDay, false);
});

test("new_draft_late_evening_caps_at_23", () => {
  const d = draft({ now: new Date("2026-10-14T21:40:00Z") });
  assert.equal(d.startTime, "23:00");
  assert.equal(d.endTime, "00:00");
  assert.equal(d.endDay, "2026-10-15");
});

test("new_draft_another_day_starts_at_9", () => {
  const d = draft({ day: "2026-10-20" });
  assert.equal(d.startDay, "2026-10-20");
  assert.equal(d.startTime, "09:00");
  assert.equal(d.endTime, "10:00");
});

test("default_calendar_is_the_persons_own", () => {
  assert.equal(defaultCalendarId([SPACE, SHARED, OWN]), "own");
  assert.equal(defaultCalendarId([SHARED, SPACE]), "shared");
  assert.equal(defaultCalendarId([calendar("ro", { canWriteEvents: false }), SPACE]), "space");
  assert.equal(defaultCalendarId([]), "");
});

test("moving_start_keeps_length", () => {
  const d = withStartTime({ ...draft(), startTime: "11:00", endTime: "12:30" }, "14:00");
  assert.equal(d.startTime, "14:00");
  assert.equal(d.endTime, "15:30");
  assert.equal(d.endDay, "2026-10-14");
});

test("end_before_start_runs_past_midnight", () => {
  const d = withEndTime({ ...draft(), startTime: "23:00", endTime: "23:30" }, "01:00");
  assert.equal(d.endTime, "01:00");
  assert.equal(d.endDay, "2026-10-15");
  const back = withEndTime(d, "23:45");
  assert.equal(back.endDay, "2026-10-14");
});

test("all_day_input_has_exclusive_end", () => {
  const input = toInput({ ...draft(), title: "Salon", allDay: true }, false);
  assert.ok(!("error" in input));
  assert.equal(input.allDay, true);
  assert.equal(input.start, "2026-10-14");
  assert.equal(input.end, "2026-10-15");
  assert.equal(input.tzid, undefined);
});

test("timed_input_is_utc", () => {
  const input = toInput({ ...draft(), title: "Point" }, false);
  assert.ok(!("error" in input));
  assert.equal(input.start, "2026-10-14T09:00:00.000Z");
  assert.equal(input.end, "2026-10-14T10:00:00.000Z");
  assert.equal(input.tzid, PARIS);
  assert.equal(input.rrule, null);
});

test("missing_title_is_an_error", () => {
  assert.deepEqual(toInput({ ...draft(), title: "   " }, false), { error: "titleRequired" });
});

test("inverted_all_day_is_an_error", () => {
  const d = { ...draft(), title: "Salon", allDay: true, startDay: "2026-10-15", endDay: "2026-10-14" };
  assert.deepEqual(toInput(d, false), { error: "endBeforeStart" });
});

test("untouched_lists_are_not_sent_on_edit", () => {
  const o = occurrence();
  const input = toInput(draftFromEvent(o, event(o), PARIS), true);
  assert.ok(!("error" in input));
  assert.equal(input.attendees, undefined);
  assert.equal("channelId" in input, false);
  assert.equal(input.files, undefined);
  assert.equal(input.reminders, undefined);

  const fresh = {
    ...draft(),
    title: "Visite",
    attendees: [
      { key: "u1", userId: "u1", name: "Léa" },
      { key: "a@b.fr", email: "a@b.fr", name: "a@b.fr" },
    ],
  };
  const created = toInput(fresh, false);
  assert.ok(!("error" in created));
  assert.deepEqual(created.attendees, [{ userId: "u1" }, { email: "a@b.fr" }]);
});

test("touched_reminders_are_sent", () => {
  const input = toInput({ ...draft(), title: "Point", reminders: [10, 60], remindersTouched: true }, false);
  assert.ok(!("error" in input));
  assert.deepEqual(input.reminders, [10, 60]);
});

test("whole_series_keeps_wall_clock_across_dst", () => {
  // Every Monday at 10:00 Paris from 19 October (summer time); the date of 26 October (winter time)
  // is moved to 11:00, and the change is made to the whole series.
  const series = occurrence({ start: "2026-10-19T08:00:00Z", end: "2026-10-19T09:00:00Z", isRecurring: true });
  const shown = occurrence({
    start: "2026-10-26T09:00:00Z",
    end: "2026-10-26T10:00:00Z",
    isRecurring: true,
    recurrenceId: "2026-10-26T09:00:00Z",
  });
  const full = event(series, { rrule: "FREQ=WEEKLY;BYDAY=MO" });
  const moved = withStartTime(draftFromEvent(shown, full, PARIS), "11:00");
  const body = toInput(moved, true);
  assert.ok(!("error" in body));
  const whole = wholeSeriesInput(body, shown, full, "own", PARIS);
  assert.equal(whole.start, "2026-10-19T09:00:00.000Z");
  assert.equal(whole.end, "2026-10-19T10:00:00.000Z");
  assert.equal(whole.calendarId, undefined);
});

test("whole_series_keeps_the_series_values_left_untouched", () => {
  const series = occurrence({ isRecurring: true, location: "Salle Atlas" });
  const shown = occurrence({ isRecurring: true, recurrenceId: "2026-10-14T09:00:00Z", title: "Réunion (déplacée)", location: "Salle Atlas" });
  const full = event(series, { rrule: "FREQ=WEEKLY;BYDAY=WE" });
  const body = toInput(draftFromEvent(shown, full, PARIS), true);
  assert.ok(!("error" in body));
  const whole = wholeSeriesInput(body, shown, full, "space", PARIS);
  assert.equal(whole.title, "Réunion");
  assert.equal(whole.location, "Salle Atlas");
  assert.equal(whole.calendarId, "space");
});

test("set_when_routes_each_field_to_its_rule", () => {
  const d = { ...draft(), startTime: "11:00", endTime: "12:00" };
  assert.equal(setWhen(d, "startDay", "2026-10-16").endDay, "2026-10-16");
  assert.equal(setWhen(d, "startTime", "15:00").endTime, "16:00");
  assert.equal(setWhen(d, "endTime", "10:00").endDay, "2026-10-15");
  const allDay = { ...d, allDay: true };
  const longer = setWhen(allDay, "endDay", "2026-10-17");
  assert.equal(longer.endDay, "2026-10-17");
  assert.equal(longer.startDay, "2026-10-14");
});

test("phone_files_of_a_personal_event_need_a_channel", () => {
  assert.equal(phoneFilesNeedChannel(OWN, null), true);
  assert.equal(phoneFilesNeedChannel(OWN, "ch1"), false);
  assert.equal(phoneFilesNeedChannel(SPACE, null), false);
  // Someone's calendar shared with the person has no space either.
  assert.equal(phoneFilesNeedChannel(SHARED, null), true);
});
