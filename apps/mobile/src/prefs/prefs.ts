/**
 * The preferences kept on the phone: how the app looks, the language it speaks, and how the agenda
 * opens.
 *
 * The look (day or night, the style, the accent, the text size) is the phone's own: a phone kept at night and a
 * computer kept in day are both right, and neither imposes it on the other. The rest follows the
 * account (decided 2026-11-03): the language and the agenda's settings are sent to the server
 * (`GET` / `PATCH /me/preferences`) and come back on every device, `MOBILE_ACCOUNT_KEYS` naming them
 * as the server does. The week's first day and a new event's length are the web's calendar keys.
 *
 * Kept free of React Native so Node tests it.
 */
import type { AccountPrefsDoc } from "@ruchoir/client";

import type { AgendaView } from "../logic/agenda.ts";
import { STYLES, type Accent, type Style } from "../theme/tokens.ts";

export type ThemeMode = "auto" | "day" | "night";
export type TextSize = "s" | "m" | "l" | "xl";
export type PrefLocale = "fr" | "en" | "es" | "de" | "it" | "pl";
/** The first day of the week, as `Date.getDay()` numbers it: Monday, Sunday or Saturday. */
export type WeekStart = 1 | 0 | 6;

export type Prefs = {
  mode: ThemeMode;
  /** Ruchoir or a flat style; a variant brings its own colours, the accent stays stored. */
  style: Style;
  accent: Accent;
  textSize: TextSize;
  /** `null`: the phone's language. */
  locale: PrefLocale | null;
  agendaView: AgendaView;
  weekStart: WeekStart;
  /** A new event's length, in minutes. */
  duration: number;
};

export const MODES: ThemeMode[] = ["auto", "day", "night"];
export const TEXT_SIZES: TextSize[] = ["s", "m", "l", "xl"];
export const LOCALES: PrefLocale[] = ["fr", "en", "es", "de", "it", "pl"];
export const AGENDA_VIEWS: AgendaView[] = ["list", "week", "month", "year"];
export const WEEK_STARTS: WeekStart[] = [1, 0, 6];
export const DURATIONS = [15, 30, 45, 60, 90, 120];
const ACCENT_NAMES: Accent[] = ["sky", "mint", "violet", "pink"];

export const DEFAULT_PREFS: Prefs = {
  mode: "auto",
  style: "ruchoir",
  accent: "violet",
  textSize: "m",
  locale: null,
  agendaView: "list",
  weekStart: 1,
  duration: 60,
};

/** One of `allowed`, or the default: each stored value is checked on its own. */
function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** What the store held, read back; anything unknown or broken falls back to its default. */
export function parsePrefs(raw: string | null): Prefs {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object") stored = parsed as Record<string, unknown>;
  } catch {
    // A store written by a broken build reads as nothing chosen.
  }
  const d = DEFAULT_PREFS;
  return {
    mode: pick(stored.mode, MODES, d.mode),
    style: pick(stored.style, STYLES, d.style),
    accent: pick(stored.accent, ACCENT_NAMES, d.accent),
    textSize: pick(stored.textSize, TEXT_SIZES, d.textSize),
    locale: pick(stored.locale, [...LOCALES, null], d.locale),
    agendaView: pick(stored.agendaView, AGENDA_VIEWS, d.agendaView),
    weekStart: pick(stored.weekStart, WEEK_STARTS, d.weekStart),
    duration: pick(stored.duration, DURATIONS, d.duration),
  };
}

/** The preferences that follow the account, by their wire key (the web's names where they share one). */
const ACCOUNT: [keyof Prefs, string, readonly unknown[]][] = [
  ["locale", "locale", LOCALES],
  ["agendaView", "agenda_view", AGENDA_VIEWS],
  ["weekStart", "calendar_week_start", WEEK_STARTS],
  ["duration", "calendar_duration", DURATIONS],
];

/** The wire keys this app reads and writes. Anything else in the document is another app's. */
export const MOBILE_ACCOUNT_KEYS: readonly string[] = ACCOUNT.map(([, wire]) => wire);

/** This phone's account preferences, as the server keeps them. */
export function toWire(prefs: Prefs): AccountPrefsDoc {
  const out: AccountPrefsDoc = {};
  for (const [name, wire] of ACCOUNT) out[wire] = prefs[name];
  return out;
}

/**
 * What a document (or a change) says, as this phone's preferences: `null` is back to the default,
 * an unreadable value leaves the preference as it is, and keys this app does not know are ignored.
 */
export function fromWire(doc: AccountPrefsDoc, current: Prefs): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  for (const [name, wire, allowed] of ACCOUNT) {
    if (!(wire in doc)) continue;
    const value = doc[wire];
    if (value === null) (out as Record<string, unknown>)[name] = DEFAULT_PREFS[name];
    else if (allowed.includes(value) && value !== current[name]) (out as Record<string, unknown>)[name] = value;
  }
  return out;
}

/** The account keys that differ between two states of the preferences, for a change to send. */
export function wireChanges(before: Prefs, after: Prefs): AccountPrefsDoc {
  const out: AccountPrefsDoc = {};
  for (const [name, wire] of ACCOUNT) if (before[name] !== after[name]) out[wire] = after[name];
  return out;
}

/** How much larger than the design's sizes text is drawn. */
export function textScale(size: TextSize): number {
  return { s: 0.9, m: 1, l: 1.12, xl: 1.25 }[size];
}

/**
 * A length in minutes as it is read: minutes under an hour, hours, or both. Written here rather than
 * with `Intl.NumberFormat`'s units, which the phone's JavaScript engine turned into seconds.
 */
export function durationLabel(
  minutes: number,
  words: { minutes: (n: number) => string; hours: (n: number) => string; hoursMinutes: (h: number, m: number) => string },
): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return words.minutes(m);
  return m === 0 ? words.hours(h) : words.hoursMinutes(h, m);
}

/**
 * Whether the queue of account preferences may be sent now: there is a way to send it, nothing is
 * being sent, something is queued, and no instance is previewing (a preview refuses every write of
 * the session: the change waits, silently, and goes up when the preview ends).
 */
export function flushAllowed(state: { hasSender: boolean; sending: boolean; queued: number; held: boolean }): boolean {
  return state.hasSender && !state.sending && state.queued > 0 && !state.held;
}
