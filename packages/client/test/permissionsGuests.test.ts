// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dateRefusal, daysLeft, endLabel, expiryTone, keepLabel, presetToInstant, showsEndDate } from "../src/permissionsLogic/guests.ts";

const PARIS = "Europe/Paris";

test("presets_resolve_to_the_end_of_the_day", () => {
  // 2026-11-15 10:00 in Paris (09:00 UTC, winter time, UTC+1).
  const now = new Date("2026-11-15T09:00:00Z");
  // One week: the 22nd, 23:59:59 in Paris is 22:59:59 UTC.
  assert.equal(presetToInstant("week", now, PARIS), "2026-11-22T22:59:59.000Z");
  assert.equal(presetToInstant("month", now, PARIS), "2026-12-15T22:59:59.000Z");
  assert.equal(presetToInstant("quarter", now, PARIS), "2027-02-15T22:59:59.000Z");
  // A chosen date, across the summer time change: the end of the 1st of July is 21:59:59 UTC.
  assert.equal(presetToInstant({ date: "2027-07-01" }, now, PARIS), "2027-07-01T21:59:59.000Z");
  // Another zone gives another instant for the same wall clock.
  assert.equal(presetToInstant({ date: "2027-07-01" }, now, "America/New_York"), "2027-07-02T03:59:59.000Z");
  // A month from the 31st lands on the last day of the shorter month.
  assert.equal(presetToInstant("month", new Date("2026-01-31T09:00:00Z"), PARIS), "2026-02-28T22:59:59.000Z");
  // Extending counts from the current end when it lies ahead, from now when it has passed.
  assert.equal(presetToInstant("month", now, PARIS, "2026-11-20T22:59:59.000Z"), "2026-12-20T22:59:59.000Z");
  assert.equal(presetToInstant("week", now, PARIS, "2026-01-01T00:00:00Z"), "2026-11-22T22:59:59.000Z");
});

test("no_date_sends_null", () => {
  assert.equal(presetToInstant("none", new Date(), PARIS), null);
});

test("soon_is_seven_days_or_less", () => {
  const now = new Date("2026-11-15T09:00:00Z");
  // Calendar days in the viewer's zone: the 22nd is 7 days from the 15th, the 23rd is 8.
  assert.equal(daysLeft("2026-11-22T22:59:59Z", now, PARIS), 7);
  assert.equal(daysLeft("2026-11-23T22:59:59Z", now, PARIS), 8);
  assert.equal(expiryTone(daysLeft("2026-11-22T22:59:59Z", now, PARIS)), "soon");
  assert.equal(expiryTone(daysLeft("2026-11-23T22:59:59Z", now, PARIS)), "calm");
  assert.equal(expiryTone(7), "soon");
  assert.equal(expiryTone(1), "soon");
  assert.equal(expiryTone(8), "calm");
  assert.equal(expiryTone(27), "calm");
});

test("days_left_counts_calendar_days", () => {
  const now = new Date("2026-11-15T09:00:00Z");
  assert.equal(daysLeft("2026-11-20T22:59:59Z", now, PARIS), 5);
  assert.equal(daysLeft("2026-11-15T22:59:59Z", now, PARIS), 0);
  assert.equal(daysLeft("2026-11-16T22:59:59Z", now, PARIS), 1);
  // Late evening on the last day is still that day, and the end is read where the viewer is.
  assert.equal(daysLeft("2026-11-15T22:59:59Z", new Date("2026-11-15T21:00:00Z"), PARIS), 0);
  assert.equal(daysLeft("2026-11-14T10:00:00Z", now, PARIS), 0);
});

test("end_label_drops_the_current_year", () => {
  const now = new Date("2026-11-15T09:00:00Z");
  assert.equal(endLabel("2026-12-12T22:59:59Z", "fr", PARIS, now), "12 décembre");
  assert.equal(endLabel("2027-01-12T22:59:59Z", "fr", PARIS, now), "12 janvier 2027");
  // Without a "now" the date is written in full, as in a table.
  assert.equal(endLabel("2026-12-12T22:59:59Z", "fr", PARIS), "12 décembre 2026");
});

test("a_past_date_is_refused_in_the_field", () => {
  const now = new Date("2026-11-15T09:00:00Z");
  assert.equal(dateRefusal("2026-11-14", now, PARIS), "past");
  assert.equal(dateRefusal("2026-11-15", now, PARIS), null);
  assert.equal(dateRefusal("2026-11-16", now, PARIS), null);
  assert.equal(dateRefusal("2031-11-16", now, PARIS), "far");
  assert.equal(dateRefusal("", now, PARIS), "empty");
  assert.equal(dateRefusal("not a date", now, PARIS), "empty");
});

test("the_date_field_only_shows_for_guests", () => {
  assert.equal(showsEndDate("guest"), true);
  assert.equal(showsEndDate("member"), false);
  assert.equal(showsEndDate("admin"), false);
  assert.equal(showsEndDate("owner"), false);
});

test("labels_read_in_the_locale", () => {
  assert.equal(endLabel("2026-11-20T22:59:59Z", "fr", PARIS), "20 novembre 2026");
  assert.equal(keepLabel("2026-11-12T10:00:00Z", new Date("2026-11-15T10:00:00Z"), "fr"), "Il y a 3 jours");
});

type Dict = Record<string, unknown>;
const LOCALES = ["fr", "en", "de", "es", "it", "pl"];
function flat(node: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node as Dict)) {
    if (typeof v === "string") out[prefix + k] = v;
    else Object.assign(out, flat(v, `${prefix}${k}.`));
  }
  return out;
}

test("every_new_string_exists_in_six_locales", () => {
  const dicts = Object.fromEntries(
    LOCALES.map((l) => [l, flat((JSON.parse(readFileSync(new URL(`../../../apps/web/lib/i18n/dictionaries/${l}.json`, import.meta.url), "utf8")) as Dict).guests)]),
  );
  const names = Object.keys(dicts.fr).map((k) => k.replace(/_(zero|one|two|few|many|other)$/, ""));
  assert.ok(Object.keys(dicts.fr).length > 10, "the guests namespace exists");
  for (const l of LOCALES) {
    for (const name of new Set(names)) {
      const has = Object.keys(dicts[l]).some((k) => k === name || k.startsWith(`${name}_`));
      assert.ok(has, `${l} lacks guests.${name}`);
    }
    for (const [k, v] of Object.entries(dicts[l])) {
      assert.ok(v.trim().length > 0, `${l} guests.${k} is empty`);
      assert.ok(!v.includes(String.fromCharCode(0x2014)), `${l} guests.${k} has an em dash`);
    }
  }
  // French says vous, never tu.
  for (const [k, v] of Object.entries(dicts.fr)) assert.ok(!/(?<!\p{L})(tu|ton|ta|tes|toi)(?!\p{L})/iu.test(v), `fr guests.${k} says tu`);
});

test("a_hand_picked_day_must_be_valid_before_it_can_be_sent", async () => {
  const { choiceRefusal } = await import("../src/permissionsLogic/guests.ts");
  const now = new Date("2026-11-15T09:00:00Z");
  assert.equal(choiceRefusal({ date: "" }, now, PARIS), "empty");
  assert.equal(choiceRefusal({ date: "2026-11-01" }, now, PARIS), "past");
  assert.equal(choiceRefusal({ date: "2026-12-01" }, now, PARIS), null);
  assert.equal(choiceRefusal("none", now, PARIS), null);
  assert.equal(choiceRefusal("month", now, PARIS), null);
});
