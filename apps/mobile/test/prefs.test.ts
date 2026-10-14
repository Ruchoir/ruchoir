import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PREFS, DURATIONS, parsePrefs, textScale } from "../src/prefs/prefs.ts";

test("nothing_stored_gives_the_defaults", () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs("not json"), DEFAULT_PREFS);
  assert.equal(DEFAULT_PREFS.accent, "violet");
  assert.equal(DEFAULT_PREFS.mode, "auto");
  assert.equal(DEFAULT_PREFS.textSize, "m");
  assert.equal(DEFAULT_PREFS.locale, null);
  assert.equal(DEFAULT_PREFS.agendaView, "list");
  assert.equal(DEFAULT_PREFS.weekStart, 1);
  assert.equal(DEFAULT_PREFS.duration, 60);
});

test("each_value_falls_back_on_its_own", () => {
  const stored = JSON.stringify({ accent: "mint", mode: "sepia", textSize: "xl", locale: "pl", weekStart: 3, duration: 30 });
  assert.deepEqual(parsePrefs(stored), { ...DEFAULT_PREFS, accent: "mint", textSize: "xl", locale: "pl", duration: 30 });
  assert.equal(parsePrefs(JSON.stringify({ locale: "ja", duration: 37 })).locale, null);
  assert.equal(parsePrefs(JSON.stringify({ duration: 37 })).duration, 60);
  assert.ok(DURATIONS.includes(60));
});

test("the_text_grows_with_its_size", () => {
  assert.equal(textScale("m"), 1);
  assert.ok(textScale("s") < 1);
  assert.ok(textScale("l") > 1 && textScale("xl") > textScale("l"));
});
