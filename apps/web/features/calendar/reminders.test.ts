// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { customMinutes, reminderLabel, remindersLabel, sameReminders } from "./reminders.ts";

type Dict = Record<string, unknown>;

function translator(locale: string) {
  const dict = JSON.parse(readFileSync(new URL(`../../lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Dict;
  const lookup = (key: string): string | undefined =>
    key.split(".").reduce<unknown>((at, part) => (at as Dict | undefined)?.[part], dict) as string | undefined;
  return (key: string, vars: Record<string, string | number> = {}) => {
    let text = lookup(key);
    if (typeof vars.count === "number") {
      const form = new Intl.PluralRules(locale).select(vars.count);
      text = lookup(`${key}_${form}`) ?? lookup(`${key}_other`) ?? text;
    }
    if (text === undefined) return key;
    return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
  };
}

const t = translator("fr") as never;
const nb = (text: string) => text.replaceAll(" ", " ");

test("a_delay_of_ones_own_reads_in_its_largest_whole_unit", () => {
  assert.equal(nb(reminderLabel(20, t)), "20 min avant");
  assert.equal(nb(reminderLabel(120, t)), "2 h avant");
  assert.equal(nb(reminderLabel(2880, t)), "2 jours avant");
  assert.equal(nb(reminderLabel(20160, t)), "2 sem. avant");
});

test("a_whole_days_delays_read_as_moments", () => {
  assert.equal(nb(reminderLabel(420, t, true)), "La veille à 17 h");
  assert.equal(nb(reminderLabel(-540, t, true)), "Le jour même à 9 h");
  assert.equal(nb(reminderLabel(900, t, true)), "1 jour avant à 9 h");
  assert.equal(nb(reminderLabel(3 * 1440 - 540, t, true)), "3 jours avant à 9 h");
});

test("a_custom_delay_becomes_minutes_within_bounds", () => {
  assert.equal(customMinutes(2, "hours", false), 120);
  assert.equal(customMinutes(4, "weeks", false), 40320);
  assert.equal(customMinutes(5, "weeks", false), null);
  assert.equal(customMinutes(0, "minutes", false), 0);
  assert.equal(customMinutes(-1, "minutes", false), null);
  assert.equal(customMinutes(2, "days", true), 2 * 1440 - 540);
  assert.equal(customMinutes(29, "days", true), null);
});

test("a_list_reads_in_order_or_says_none", () => {
  assert.equal(nb(remindersLabel([10, 1440], t, false)), "10 min avant, 1 jour avant");
  assert.equal(remindersLabel([], t, false), "Aucun rappel");
});

test("two_lists_of_reminders_are_the_same_whatever_their_order", () => {
  assert.equal(sameReminders([10, 60], [60, 10]), true);
  assert.equal(sameReminders([10], [10, 60]), false);
  assert.equal(sameReminders([], []), true);
  // Following the calendar is not choosing none.
  assert.equal(sameReminders(undefined, []), false);
  assert.equal(sameReminders(undefined, undefined), true);
});
