import { test } from "node:test";
import assert from "node:assert/strict";

import { repeatChoices, repeatLabel } from "../src/screens/agenda/form/repeat.ts";
import { newDraft } from "../src/logic/eventForm.ts";

const say = (key: string, vars?: Record<string, string | number>) => (vars?.days ? `${key}:${vars.days}` : key);
const words = { none: "Ne se répète pas", imported: "Importée" };
const d = newDraft({ day: "2026-10-14", now: new Date("2026-10-14T08:20:00Z"), timeZone: "Europe/Paris", calendars: [] });

test("repeat_choices_are_the_five_usual_rules_said_in_words", () => {
  const choices = repeatChoices("2026-10-14", "fr", say);
  assert.deepEqual(choices.map((c) => c.preset), ["daily", "workdays", "weekly", "monthly", "yearly"]);
  assert.match(choices[2].label, /^calendar\.rule\.weekly/);
});

test("repeat_label_says_what_the_draft_does", () => {
  assert.equal(repeatLabel(d, "fr", say, words), "Ne se répète pas");
  assert.equal(repeatLabel({ ...d, preset: "imported", originalRule: "FREQ=WEEKLY;BYWEEKNO=2" }, "fr", say, words), "Importée");
  assert.match(repeatLabel({ ...d, preset: "weekly", ruleTouched: true }, "fr", say, words), /^calendar\.rule\.weekly/);
  // A custom rule is said with the start's day in it, as it will be saved.
  const custom = { ...d, preset: "custom" as const, ruleTouched: true, custom: { ...d.custom, freq: "WEEKLY" as const, days: [] } };
  assert.match(repeatLabel(custom, "fr", say, words), /^calendar\.rule\.weekly/);
});
