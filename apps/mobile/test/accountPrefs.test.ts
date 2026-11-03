import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PREFS, MOBILE_ACCOUNT_KEYS, fromWire, toWire, type Prefs } from "../src/prefs/prefs.ts";
import { buildConversations } from "../src/logic/conversations.ts";

test("mobile_sends_only_its_four_keys", () => {
  assert.deepEqual(Object.keys(toWire(DEFAULT_PREFS)).sort(), [...MOBILE_ACCOUNT_KEYS].sort());
});

test("theme_and_size_stay_on_the_phone", () => {
  const night: Prefs = { ...DEFAULT_PREFS, mode: "night", accent: "pink", textSize: "xl" };
  const wire = toWire(night);
  for (const key of ["mode", "accent", "textSize", "text_size", "theme"]) assert.equal(key in wire, false, key);
  // And a document naming them changes nothing here.
  assert.deepEqual(fromWire({ mode: "day", accent: "sky", text_size: "s" }, night), {});
});

test("week_start_and_duration_share_the_web_keys", () => {
  const mine: Prefs = { ...DEFAULT_PREFS, weekStart: 0, duration: 30, locale: "de", agendaView: "year" };
  assert.deepEqual(toWire(mine), { locale: "de", agenda_view: "year", calendar_week_start: 0, calendar_duration: 30 });
  assert.deepEqual(fromWire({ calendar_week_start: 6, calendar_duration: 90, calendar_open_at: 7 }, mine), { weekStart: 6, duration: 90 });
});

test("an_invalid_agenda_view_falls_back", () => {
  const mine: Prefs = { ...DEFAULT_PREFS, agendaView: "month", locale: "it" };
  // Unreadable: left as it is. Null: back to the default.
  assert.deepEqual(fromWire({ agenda_view: "decade", locale: null }, mine), { locale: DEFAULT_PREFS.locale });
  assert.deepEqual(fromWire({ agenda_view: null }, mine), { agendaView: DEFAULT_PREFS.agendaView });
});

test("a_hidden_conversation_says_so", () => {
  const items = buildConversations([], [
    { id: "d1", name: "Léa", presence: "offline", unread: 0, userId: "u1", hidden: true },
    { id: "d2", name: "Hugo", presence: "offline", unread: 0, userId: "u2", hidden: false },
  ]);
  assert.equal(items.find((i) => i.id === "d1")?.hidden, true);
  assert.equal(items.find((i) => i.id === "d2")?.hidden, undefined);
});
