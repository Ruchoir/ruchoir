// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRule } from "../src/calendarLogic/rule.ts";
import { rulePhrase } from "../src/calendarLogic/rulePhrase.ts";

const DAYS: Record<string, string> = {
  "calendar.rule.mo": "lundi",
  "calendar.rule.tu": "mardi",
  "calendar.rule.fr": "vendredi",
};
const t = (key: string, vars: Record<string, string | number> = {}) => {
  if (key === "calendar.rule.onDay") return `le ${vars.day}`;
  if (key === "calendar.rule.weekly") return `Chaque semaine, ${vars.days}`;
  return DAYS[key] ?? key;
};

/** Hermes, which runs the phone apps, has no `Intl.ListFormat`: the phrase must still be built. */
test("rule_phrase_without_intl_list_format", () => {
  const intl = Intl as { ListFormat?: unknown };
  const original = intl.ListFormat;
  delete intl.ListFormat;
  try {
    const phrase = (rule: string, locale = "fr") => rulePhrase(parseRule(rule)!, "2026-10-08", locale, t);
    assert.equal(phrase("FREQ=WEEKLY;BYDAY=MO,FR"), "Chaque semaine, le lundi et le vendredi");
    assert.equal(phrase("FREQ=WEEKLY;BYDAY=MO,TU,FR"), "Chaque semaine, le lundi, le mardi et le vendredi");
    assert.equal(phrase("FREQ=WEEKLY;BYDAY=MO,TU,FR", "en"), "Chaque semaine, le lundi, le mardi, and le vendredi");
    assert.equal(phrase("FREQ=WEEKLY;BYDAY=MO"), "Chaque semaine, le lundi");
  } finally {
    intl.ListFormat = original;
  }
});
