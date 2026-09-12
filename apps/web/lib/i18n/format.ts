/**
 * Numbers, dates and sizes, in the language in force.
 *
 * These used to be formatted with the language written into the call ("fr-FR"), which is the same
 * mistake as a hard-coded sentence and harder to see: nothing about `toLocaleDateString("fr-FR")`
 * looks like French text, and it still showed "7 sept." to a Polish reader. Everything that turns a
 * value into something a person reads goes through here.
 *
 * The language is read at call time rather than captured, so the screens that re-render on a change
 * of language draw their dates in the new one without refetching anything.
 */

import { currentLocale } from "./current";
import type { Locale } from "./config";

/** Time of day: "17:45" in French, "5:45 PM" where that is what a clock says. */
export function formatTime(at: Date | string | number, locale: Locale = currentLocale()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
}

/** Day and month, short: "7 sept.", "Sep 7", "7 wrz". */
export function formatShortDate(at: Date | string | number, locale: Locale = currentLocale()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
}

/** Full date and time, for a tooltip or a detail line. */
export function formatDateTime(at: Date | string | number, locale: Locale = currentLocale()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Date alone, medium length: for a key added on, a session opened on. */
export function formatDate(at: Date | string | number, locale: Locale = currentLocale()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * The word for the day before today, in the reader's language.
 *
 * From `Intl.RelativeTimeFormat` rather than the dictionary: every language already has this word in
 * the browser, and six translations of "hier" is six entries that can only ever be wrong.
 */
function yesterdayWord(locale: Locale): string {
  const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");
  return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1);
}

/**
 * How a message or a file is stamped in a list: the time today, "Yesterday, 17:45" the day before,
 * and a short date beyond that. The gutter is narrow, so the longer forms are for hovering.
 */
export function formatStamp(at: Date | string | number, locale: Locale = currentLocale()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (sameDay(date, now)) return formatTime(date, locale);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `${yesterdayWord(locale)}, ${formatTime(date, locale)}`;
  return formatShortDate(date, locale);
}

/** Decimal units, as storage is sold and as every file manager counts it. */
const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/**
 * A byte count in the reader's language: "3,4 Mo", "3.4 MB", "3,4 MB".
 *
 * `Intl.NumberFormat` carries both halves of what changes between languages: the unit's name and
 * the decimal separator. Writing "Ko" and swapping the point for a comma by hand got French right
 * and every other language wrong.
 */
export function formatBytes(bytes: number, locale: Locale = currentLocale()): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const decimals = unit === 0 || value >= 100 ? 0 : 1;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: BYTE_UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: decimals,
  }).format(value);
}

/** A plain count, grouped the way the language groups thousands. */
export function formatNumber(value: number, locale: Locale = currentLocale()): string {
  return new Intl.NumberFormat(locale).format(value);
}
