import { test } from "node:test";
import assert from "node:assert/strict";

import { busyDuring, placeOnStrip, stripWindow } from "../src/logic/availability.ts";

const H = 3_600_000;
const day = Date.parse("2026-10-14T00:00:00Z");

test("strip_spans_the_working_day_around_the_event", () => {
  assert.deepEqual(stripWindow(day, day + 10 * H, day + 11 * H), { first: 7, last: 20 });
});

test("strip_widens_for_an_early_or_late_event", () => {
  assert.deepEqual(stripWindow(day, day + 6 * H, day + 7 * H), { first: 5, last: 20 });
  assert.deepEqual(stripWindow(day, day + 21 * H, day + 23 * H), { first: 7, last: 24 });
});

test("placing_clamps_to_the_window", () => {
  const window = { first: 8, last: 20 };
  assert.deepEqual(placeOnStrip(day, day + 11 * H, day + 14 * H, window), { left: 0.25, width: 0.25 });
  // Before the window and running into it: from its left edge.
  assert.deepEqual(placeOnStrip(day, day + 6 * H, day + 9 * H, window), { left: 0, width: 1 / 12 });
});

test("busy_during_counts_overlaps_not_touching_ends", () => {
  const busy = [{ start: "2026-10-14T09:00:00Z", end: "2026-10-14T10:00:00Z" }];
  assert.equal(busyDuring(busy, Date.parse("2026-10-14T09:30:00Z"), Date.parse("2026-10-14T11:00:00Z")), true);
  assert.equal(busyDuring(busy, Date.parse("2026-10-14T10:00:00Z"), Date.parse("2026-10-14T11:00:00Z")), false);
});
