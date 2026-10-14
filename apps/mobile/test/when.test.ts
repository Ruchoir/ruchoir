import { test } from "node:test";
import assert from "node:assert/strict";

import { clockLabel, fromPicked, longDay, mediumDay, uses24h, whenDate } from "../src/screens/agenda/form/when.ts";
import { newDraft } from "../src/logic/eventForm.ts";

const d = { ...newDraft({ day: "2026-10-14", now: new Date("2026-10-14T08:20:00Z"), timeZone: "Europe/Paris", calendars: [] }), endDay: "2026-10-16" };

test("picked_dates_and_times_round_trip", () => {
  assert.equal(fromPicked(whenDate(d, "startDay"), "startDay"), "2026-10-14");
  assert.equal(fromPicked(whenDate(d, "endDay"), "endDay"), "2026-10-16");
  assert.equal(fromPicked(whenDate(d, "startTime"), "startTime"), "11:00");
  assert.equal(fromPicked(whenDate(d, "endTime"), "endTime"), "12:00");
});

test("days_and_times_read_in_the_language", () => {
  assert.equal(longDay("2026-10-14", "fr"), "Mercredi 14 octobre 2026");
  assert.equal(clockLabel("09:05", "fr"), "09:05");
  assert.equal(uses24h("fr"), true);
  assert.equal(uses24h("en-US"), false);
});

test("a_day_reads_short_beside_its_time", () => {
  assert.equal(mediumDay("2026-10-14", "fr"), "Mer. 14 oct. 2026");
});
