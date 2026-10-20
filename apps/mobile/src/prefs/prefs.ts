/**
 * The preferences kept on the phone: how the app looks, the language it speaks, and how the agenda
 * opens. What the server acts on (notifications) is the account's and lives there; the web keeps the
 * same kind of choices in its browser, so neither device imposes its look on the other.
 *
 * Kept free of React Native so Node tests it.
 */
import type { AgendaView } from "../logic/agenda.ts";
import type { Accent } from "../theme/tokens.ts";

export type ThemeMode = "auto" | "day" | "night";
export type TextSize = "s" | "m" | "l" | "xl";
export type PrefLocale = "fr" | "en" | "es" | "de" | "it" | "pl";
/** The first day of the week, as `Date.getDay()` numbers it: Monday, Sunday or Saturday. */
export type WeekStart = 1 | 0 | 6;

export type Prefs = {
  mode: ThemeMode;
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
    accent: pick(stored.accent, ACCENT_NAMES, d.accent),
    textSize: pick(stored.textSize, TEXT_SIZES, d.textSize),
    locale: pick(stored.locale, [...LOCALES, null], d.locale),
    agendaView: pick(stored.agendaView, AGENDA_VIEWS, d.agendaView),
    weekStart: pick(stored.weekStart, WEEK_STARTS, d.weekStart),
    duration: pick(stored.duration, DURATIONS, d.duration),
  };
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
