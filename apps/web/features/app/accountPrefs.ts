/**
 * Which of the web's settings follow the account, and how they read on the wire.
 *
 * The server keeps one flat document per account (`GET` / `PATCH /me/preferences`, see
 * `@ruchoir/client`'s `accountPrefs`). Everything that describes how the person organises Ruchoir
 * goes there: the font, the language, the rail, the shortcuts, the calendar's settings. What
 * describes this screen stays in this browser only, by decision (2026-11-03): the theme (accent and
 * day or night), the text size, the thread panel's width, and the flags about this browser or app
 * (`notifPrompted`, `notifShared`, `emojiPack`). Notification settings have their own route.
 *
 * The calendar is flattened into `calendar_*` keys: the phone knows two of its fields, and a whole
 * `calendar` object sent from there would erase the others.
 *
 * Kept free of React so Node tests it.
 */
import type { AccountPrefsDoc } from "@ruchoir/client";

import { calendarPrefs, type CalendarPrefs } from "../calendar/prefs.ts";
import { LOCALES } from "../../lib/i18n/config.ts";
import type { Settings } from "./settings.tsx";

/** The settings that follow the account. */
export type AccountSettings = Pick<
  Settings,
  | "font"
  | "emojiAnimated"
  | "locale"
  | "spaceOrder"
  | "collapsedSections"
  | "shortcuts"
  | "welcome"
  | "filesLayout"
  | "defaultPanel"
  | "externalLinkWarning"
  | "calendar"
>;

type Plain = Exclude<keyof AccountSettings, "calendar" | "shortcuts" | "welcome">;

const oneOf =
  (allowed: readonly unknown[]) =>
  (value: unknown): boolean =>
    allowed.includes(value);
const isBool = (value: unknown): boolean => typeof value === "boolean";
const isStrings = (value: unknown): boolean => Array.isArray(value) && value.every((x) => typeof x === "string");

/** The settings stored as they are, with the wire key and what a readable value is. */
const PLAIN: [Plain, string, (value: unknown) => boolean][] = [
  ["font", "font", oneOf(["plex", "system", "dyslexic"])],
  ["emojiAnimated", "emoji_animated", isBool],
  ["locale", "locale", oneOf(LOCALES)],
  ["spaceOrder", "space_order", isStrings],
  ["collapsedSections", "collapsed_sections", isStrings],
  ["filesLayout", "files_layout", oneOf(["list", "grid"])],
  ["defaultPanel", "default_panel", oneOf(["members", "files", "pinned", "none"])],
  ["externalLinkWarning", "external_link_warning", isBool],
];

/** The calendar's fields and their wire keys. */
const CALENDAR: [keyof CalendarPrefs, string][] = [
  ["viewDesktop", "calendar_view_desktop"],
  ["viewPhone", "calendar_view_phone"],
  ["weekStart", "calendar_week_start"],
  ["clock", "calendar_clock"],
  ["weekends", "calendar_weekends"],
  ["weekNumbers", "calendar_week_numbers"],
  ["openAt", "calendar_open_at"],
  ["workHours", "calendar_work_hours"],
  ["workStart", "calendar_work_start"],
  ["workEnd", "calendar_work_end"],
  ["duration", "calendar_duration"],
];

/** Every wire key the web reads and writes. The phone's `agenda_view` is not one. */
export const WEB_ACCOUNT_KEYS: readonly string[] = [
  ...PLAIN.map(([, wire]) => wire),
  "shortcuts",
  "welcome",
  ...CALENDAR.map(([, wire]) => wire),
];

/** Whether a setting follows the account (anything else stays in this browser). */
export function isAccountSetting(key: string): key is keyof AccountSettings {
  return key === "calendar" || key === "shortcuts" || key === "welcome" || PLAIN.some(([name]) => name === key);
}

/** The account settings as the server keeps them. */
export function toWire(settings: AccountSettings): AccountPrefsDoc {
  const out: AccountPrefsDoc = {};
  for (const [name, wire] of PLAIN) out[wire] = settings[name];
  out.shortcuts = { ...settings.shortcuts };
  out.welcome = { dismissed: settings.welcome.dismissed, done: [...settings.welcome.done] };
  for (const [field, wire] of CALENDAR) out[wire] = settings.calendar[field];
  return out;
}

/**
 * What a document (or a change) says, as settings. A key at `null` goes back to `defaults`; a
 * value this browser cannot read leaves the setting as it is; keys the web does not know are none
 * of its business. `current` fills the calendar fields the document does not name.
 */
export function fromWire(
  doc: AccountPrefsDoc,
  current: AccountSettings,
  defaults: AccountSettings,
): Partial<AccountSettings> {
  const out: Partial<AccountSettings> = {};
  const put = <K extends keyof AccountSettings>(key: K, value: AccountSettings[K]) => {
    out[key] = value;
  };
  for (const [name, wire, valid] of PLAIN) {
    if (!(wire in doc)) continue;
    const value = doc[wire];
    if (value === null) put(name, defaults[name]);
    else if (valid(value)) put(name, value as AccountSettings[typeof name]);
  }
  if ("shortcuts" in doc) {
    const raw = doc.shortcuts;
    const bindings = { ...defaults.shortcuts };
    if (raw && typeof raw === "object") {
      for (const id of Object.keys(bindings) as (keyof typeof bindings)[]) {
        const chord = (raw as Record<string, unknown>)[id];
        if (typeof chord === "string") bindings[id] = chord;
      }
    }
    put("shortcuts", bindings);
  }
  if ("welcome" in doc) {
    const raw = doc.welcome as { dismissed?: unknown; done?: unknown } | null;
    put("welcome", {
      dismissed: typeof raw?.dismissed === "boolean" ? raw.dismissed : false,
      done: isStrings(raw?.done) ? [...(raw?.done as string[])] : [],
    });
  }
  if (CALENDAR.some(([, wire]) => wire in doc)) {
    const merged: Record<string, unknown> = { ...current.calendar };
    for (const [field, wire] of CALENDAR) {
      if (!(wire in doc)) continue;
      merged[field] = doc[wire] === null ? defaults.calendar[field] : doc[wire];
    }
    // The calendar's own reader: an unreadable field takes its default, as from storage.
    put("calendar", calendarPrefs(merged));
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What a change of one setting sends: `{}` for a device setting or no change, only the calendar fields that moved. */
export function wireChanges(key: keyof AccountSettings, before: AccountSettings, after: AccountSettings): AccountPrefsDoc {
  if (!isAccountSetting(key)) return {};
  const was = toWire(before);
  const now = toWire(after);
  const out: AccountPrefsDoc = {};
  const wires =
    key === "calendar"
      ? CALENDAR.map(([, wire]) => wire)
      : key === "shortcuts" || key === "welcome"
        ? [key]
        : PLAIN.filter(([name]) => name === key).map(([, wire]) => wire);
  for (const wire of wires) {
    if (!same(was[wire], now[wire])) out[wire] = now[wire] ?? null;
  }
  return out;
}
