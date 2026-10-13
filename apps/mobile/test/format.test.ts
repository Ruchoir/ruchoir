import { test } from "node:test";
import assert from "node:assert/strict";

import { dayKey, dayStamp, fileSize, listStamp } from "../src/logic/format.ts";

const PARIS = "Europe/Paris";
const NOW = new Date("2026-10-13T12:00:00Z");

test("a_day_is_counted_in_the_readers_timezone", () => {
  assert.equal(dayKey("2026-10-13T22:30:00Z", PARIS), "2026-10-14");
});

test("today_shows_the_time", () => {
  assert.deepEqual(listStamp("2026-10-13T08:42:00Z", NOW, "fr", PARIS), { kind: "time", text: "10:42" });
});

test("yesterday_says_so", () => {
  assert.equal(listStamp("2026-10-12T08:42:00Z", NOW, "fr", PARIS).kind, "yesterday");
});

test("this_week_shows_the_weekday", () => {
  assert.deepEqual(listStamp("2026-10-10T08:00:00Z", NOW, "fr", PARIS), { kind: "date", text: "sam." });
});

test("older_shows_the_date", () => {
  assert.deepEqual(listStamp("2026-09-01T08:00:00Z", NOW, "fr", PARIS), { kind: "date", text: "01/09" });
});

test("sizes_read_in_the_readers_units", () => {
  assert.equal(fileSize(240 * 1000, "fr"), "240\u202fko");
  assert.equal(fileSize(3_400_000, "en"), "3.4 MB");
});

test("a_file_changed_today_says_today_not_the_time", () => {
  assert.deepEqual(dayStamp("2026-10-13T08:42:00Z", NOW, "fr", PARIS), { kind: "today" });
  assert.deepEqual(dayStamp("2026-10-12T08:42:00Z", NOW, "fr", PARIS), { kind: "yesterday" });
  assert.deepEqual(dayStamp("2026-10-10T08:00:00Z", NOW, "fr", PARIS), { kind: "date", text: "sam." });
  assert.deepEqual(dayStamp("2026-09-01T08:00:00Z", NOW, "fr", PARIS), { kind: "date", text: "01/09" });
});
