// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CALENDAR_PREFS } from "../calendar/prefs.ts";
import { fromWire, toWire, WEB_ACCOUNT_KEYS, wireChanges, type AccountSettings } from "./accountPrefs.ts";

const defaults: AccountSettings = {
  font: "plex",
  emojiAnimated: true,
  locale: null,
  spaceOrder: [],
  collapsedSections: [],
  shortcuts: { search: "Mod+K", help: "?" },
  welcome: { dismissed: false, done: [] },
  filesLayout: "list",
  defaultPanel: "members",
  externalLinkWarning: true,
  calendar: DEFAULT_CALENDAR_PREFS,
};

// What the provider holds: the account settings beside the device's own.
const device = { accent: "mint", mode: "night", textSize: "xl", threadWidth: 600, notifPrompted: true, notifShared: true, emojiPack: false };

test("device_keys_are_never_sent", () => {
  const wire = toWire({ ...defaults, ...device } as AccountSettings);
  for (const key of ["accent", "mode", "theme", "text_size", "textSize", "thread_width", "notif_prompted", "notif_shared", "emoji_pack"]) {
    assert.equal(key in wire, false, key);
  }
  assert.deepEqual(Object.keys(wire).sort(), [...WEB_ACCOUNT_KEYS].sort());
  assert.equal(WEB_ACCOUNT_KEYS.includes("agenda_view"), false, "the phone's own agenda view");
  assert.deepEqual(wireChanges("accent" as keyof AccountSettings, defaults, defaults), {});
});

test("calendar_is_flattened_and_back", () => {
  const mine: AccountSettings = { ...defaults, calendar: { ...DEFAULT_CALENDAR_PREFS, weekStart: 0, duration: 30, workStart: 8, workEnd: 17 } };
  const wire = toWire(mine);
  assert.equal(wire.calendar_week_start, 0);
  assert.equal(wire.calendar_duration, 30);
  assert.equal(wire.calendar_work_end, 17);
  assert.equal("calendar" in wire, false);
  assert.deepEqual(fromWire(wire, defaults, defaults).calendar, mine.calendar);
});

test("a_null_goes_back_to_the_default", () => {
  const current: AccountSettings = { ...defaults, font: "dyslexic", locale: "en", calendar: { ...DEFAULT_CALENDAR_PREFS, duration: 90 } };
  const out = fromWire({ font: null, locale: null, calendar_duration: null }, current, defaults);
  assert.equal(out.font, "plex");
  assert.equal(out.locale, null);
  assert.equal(out.calendar?.duration, 60);
});

test("an_invalid_value_falls_back", () => {
  const current: AccountSettings = { ...defaults, font: "system" };
  const out = fromWire(
    { font: "comic", locale: "xx", files_layout: 3, shortcuts: { search: "Mod+P", retired: "X", help: 4 }, calendar_open_at: 99 },
    current,
    defaults,
  );
  // An unreadable value leaves the setting as it is.
  assert.equal("font" in out, false);
  assert.equal("locale" in out, false);
  assert.equal("filesLayout" in out, false);
  // Known commands only, strings only: the rest keeps its default.
  assert.deepEqual(out.shortcuts, { search: "Mod+P", help: "?" });
  assert.equal(out.calendar?.openAt, DEFAULT_CALENDAR_PREFS.openAt);
  // Keys this app does not know are not settings here.
  assert.deepEqual(Object.keys(fromWire({ agenda_view: "year", space_order: ["s1"] }, current, defaults)), ["spaceOrder"]);
});

test("only_the_changed_calendar_field_is_sent", () => {
  const after: AccountSettings = { ...defaults, calendar: { ...DEFAULT_CALENDAR_PREFS, weekends: false } };
  assert.deepEqual(wireChanges("calendar", defaults, after), { calendar_weekends: false });
  assert.deepEqual(wireChanges("locale", defaults, { ...defaults, locale: "de" }), { locale: "de" });
  assert.deepEqual(wireChanges("locale", { ...defaults, locale: "de" }, defaults), { locale: null });
  assert.deepEqual(wireChanges("spaceOrder", defaults, { ...defaults }), {});
});
