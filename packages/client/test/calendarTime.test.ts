// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { clashes, freeSlots, localDay, movedSeriesStart, zonedTime } from "../src/calendarLogic/time.ts";

const PARIS = "Europe/Paris";

test("local days and wall times read in the zone", () => {
  assert.equal(localDay("2026-10-20T22:30:00Z", PARIS), "2026-10-21");
  assert.equal(localDay("2026-10-20T22:30:00Z", "America/New_York"), "2026-10-20");
  assert.equal(zonedTime("2026-10-26", 9 * 60, PARIS), "2026-10-26T08:00:00.000Z");
  assert.equal(zonedTime("2026-07-01", 9 * 60, PARIS), "2026-07-01T07:00:00.000Z");
});

test("a_new_event_clashes_with_what_overlaps_it_in_any_calendar", () => {
  const timed = (eventId: string, start: string, end: string) => ({ eventId, allDay: false, start, end });
  const found = [
    timed("a", "2026-10-08T08:00:00Z", "2026-10-08T09:00:00Z"), // 10:00 - 11:00 in Paris
    timed("b", "2026-10-08T09:00:00Z", "2026-10-08T10:00:00Z"), // starts as ours ends: no clash
    timed("c", "2026-10-08T07:30:00Z", "2026-10-08T08:30:00Z"),
    { eventId: "d", allDay: true, start: "2026-10-08", end: "2026-10-09" },
    { eventId: "e", allDay: true, start: "2026-10-09", end: "2026-10-10" },
  ];
  // 10:30 - 11:00 in Paris.
  const ours = { start: "2026-10-08T08:30:00Z", end: "2026-10-08T09:00:00Z" };
  assert.deepEqual(clashes(found, ours, PARIS).map((o) => o.eventId), ["a", "d"]);
  // The event being edited does not clash with itself.
  assert.deepEqual(clashes(found, ours, PARIS, "a").map((o) => o.eventId), ["d"]);
});

test("free_slots_skip_the_busy_hours_and_the_closed_ones", () => {
  const opts = { days: 14, duration: 60, dayStart: 9, dayEnd: 18, weekends: true, tz: PARIS };
  // Monday 19 October, 10:00 in Paris; someone is busy until noon.
  const busy = [{ start: "2026-10-19T08:00:00Z", end: "2026-10-19T10:00:00Z" }];
  assert.deepEqual(
    freeSlots(busy, { ...opts, from: "2026-10-19T08:00:00Z" }).map((s) => s.start),
    ["2026-10-19T10:00:00Z", "2026-10-19T11:00:00Z", "2026-10-19T12:00:00Z"],
  );
  // Friday evening, after hours and without the weekend: Monday morning, in winter time.
  assert.deepEqual(
    freeSlots([], { ...opts, weekends: false, from: "2026-10-23T16:30:00Z", limit: 1 }),
    [{ start: "2026-10-26T08:00:00Z", end: "2026-10-26T09:00:00Z" }],
  );
  // A slot does not start in the past, and it is a whole half hour.
  assert.equal(freeSlots([], { ...opts, from: "2026-10-19T08:10:00Z", limit: 1 })[0].start, "2026-10-19T08:30:00Z");
  // Nothing fits: nothing proposed.
  assert.deepEqual(freeSlots([], { ...opts, duration: 600, from: "2026-10-19T08:00:00Z" }), []);
});

test("a_whole_series_moved_from_a_winter_date_keeps_its_summer_head_at_the_same_wall_time", () => {
  // Series every Saturday at 9:00 Paris from 24 October (summer). The occurrence of 7 November
  // (winter, 08:00Z) is moved a week later at 9:00: the head moves a week, still at 9:00.
  assert.equal(
    movedSeriesStart("2026-10-24T07:00:00Z", "2026-11-07T08:00:00Z", "2026-11-14T08:00:00Z", PARIS),
    "2026-10-31T08:00:00.000Z",
  );
  // An hour later on the same day: the head an hour later too, in its own season.
  assert.equal(
    movedSeriesStart("2026-10-24T07:00:00Z", "2026-11-07T08:00:00Z", "2026-11-07T09:00:00Z", PARIS),
    "2026-10-24T08:00:00.000Z",
  );
});

