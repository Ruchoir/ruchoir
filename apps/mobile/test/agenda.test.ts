import { test } from "node:test";
import assert from "node:assert/strict";

import { groupByDay, monthGrid, rangeForView, shiftAnchor, weekdayOrder, weekOf } from "../src/logic/agenda.ts";

const PARIS = "Europe/Paris";
const occ = (id: string, start: string, end: string, allDay = false) => ({ eventId: id, start, end, allDay }) as never;

test("week_of_2026_06_16_starts_monday_15", () => {
  assert.deepEqual(weekOf("2026-06-16"), [
    "2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21",
  ]);
});

test("a_sunday_belongs_to_the_week_before", () => {
  assert.equal(weekOf("2026-06-21")[0], "2026-06-15");
});

test("month_grid_june_2026_starts_on_monday_1", () => {
  const grid = monthGrid("2026-06");
  assert.deepEqual(grid[0], ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06", "2026-06-07"]);
  assert.deepEqual(grid[4], ["2026-06-29", "2026-06-30", null, null, null, null, null]);
  assert.equal(grid.length, 5);
});

test("a_month_starting_midweek_is_padded", () => {
  assert.deepEqual(monthGrid("2026-10")[0], [null, null, null, "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
});

test("dst_change_keeps_events_on_their_day", () => {
  // 09:00 in Paris on either side of the change of 2026-10-25 (UTC+2, then UTC+1).
  const days = groupByDay(
    [occ("a", "2026-10-24T07:00:00Z", "2026-10-24T08:00:00Z"), occ("b", "2026-10-25T08:00:00Z", "2026-10-25T09:00:00Z"), occ("c", "2026-10-26T08:00:00Z", "2026-10-26T09:00:00Z")],
    PARIS,
  );
  assert.deepEqual(days.map((d) => [d.day, d.items.map((i: { eventId: string }) => i.eventId)]), [
    ["2026-10-24", ["a"]],
    ["2026-10-25", ["b"]],
    ["2026-10-26", ["c"]],
  ]);
});

test("late_evening_utc_is_the_next_day_in_paris", () => {
  const [day] = groupByDay([occ("a", "2026-10-13T22:30:00Z", "2026-10-13T23:30:00Z")], PARIS);
  assert.equal(day.day, "2026-10-14");
});

test("all_day_event_spans_its_days", () => {
  const days = groupByDay([occ("a", "2026-10-20", "2026-10-22", true)], PARIS);
  assert.deepEqual(days.map((d) => d.day), ["2026-10-20", "2026-10-21"]);
});

test("a_day_lists_all_day_events_first_then_by_time", () => {
  const [day] = groupByDay(
    [occ("late", "2026-10-20T15:00:00Z", "2026-10-20T16:00:00Z"), occ("early", "2026-10-20T07:00:00Z", "2026-10-20T08:00:00Z"), occ("all", "2026-10-20", "2026-10-21", true)],
    PARIS,
  );
  assert.deepEqual(day.items.map((i: { eventId: string }) => i.eventId), ["all", "early", "late"]);
});

test("ranges_cover_the_view_with_a_day_of_margin", () => {
  assert.deepEqual(rangeForView("week", "2026-06-16"), { from: "2026-06-14T00:00:00Z", to: "2026-06-23T00:00:00Z" });
  assert.deepEqual(rangeForView("month", "2026-06-16"), { from: "2026-05-31T00:00:00Z", to: "2026-07-02T00:00:00Z" });
  assert.deepEqual(rangeForView("list", "2026-06-16"), { from: "2026-06-15T00:00:00Z", to: "2026-07-18T00:00:00Z" });
});

test("moving_the_anchor_goes_by_the_view", () => {
  assert.equal(shiftAnchor("week", "2026-06-16", 1), "2026-06-23");
  assert.equal(shiftAnchor("month", "2026-01-31", 1), "2026-02-01");
  assert.equal(shiftAnchor("month", "2026-06-16", -1), "2026-05-01");
});

test("a_week_can_start_on_sunday_or_saturday", () => {
  // 2026-10-14 is a Wednesday.
  assert.equal(weekOf("2026-10-14")[0], "2026-10-12");
  assert.equal(weekOf("2026-10-14", 0)[0], "2026-10-11");
  assert.equal(weekOf("2026-10-14", 6)[0], "2026-10-10");
  // A Sunday opens its own week when weeks start on Sunday, and closes it otherwise.
  assert.equal(weekOf("2026-10-11", 0)[0], "2026-10-11");
  assert.equal(weekOf("2026-10-11", 1)[0], "2026-10-05");
  // What is fetched follows the week on screen.
  assert.equal(rangeForView("week", "2026-10-14", 0).from, "2026-10-10T00:00:00Z");
});

test("a_month_grid_follows_the_first_day_of_the_week", () => {
  // October 2026 begins on a Thursday.
  assert.equal(monthGrid("2026-10")[0].indexOf("2026-10-01"), 3);
  assert.equal(monthGrid("2026-10", 0)[0].indexOf("2026-10-01"), 4);
  assert.equal(monthGrid("2026-10", 6)[0].indexOf("2026-10-01"), 5);
  assert.deepEqual(weekdayOrder(0), [6, 0, 1, 2, 3, 4, 5]);
  assert.deepEqual(weekdayOrder(1), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(weekdayOrder(6), [5, 6, 0, 1, 2, 3, 4]);
});
