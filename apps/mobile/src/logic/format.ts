/**
 * Dates and sizes as a reader expects them, in their language and their timezone.
 *
 * Every function takes the locale and the zone explicitly, so the tests pin them and the screens
 * pass the person's own (`useLocale`).
 */

/** `YYYY-MM-DD` of an instant, in a zone: what "the same day" means for a reader there. */
export function dayKey(iso: string | Date, timeZone: string): string {
  // The parts, not a formatted string: the key must not depend on how a language writes a date.
  const parts = new Intl.DateTimeFormat(undefined, { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    typeof iso === "string" ? new Date(iso) : iso,
  );
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Days between two day keys (`b - a`). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function timeOf(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/**
 * The stamp on a list row (mockup 12): the time today, "yesterday", the weekday within the week,
 * the date beyond. "yesterday" is a word, so the screen says it from the dictionary.
 */
export function listStamp(
  iso: string,
  now: Date,
  locale: string,
  timeZone: string,
): { kind: "time" | "date"; text: string } | { kind: "yesterday" } {
  const days = daysBetween(dayKey(iso, timeZone), dayKey(now, timeZone));
  if (days <= 0) return { kind: "time", text: timeOf(iso, locale, timeZone) };
  if (days === 1) return { kind: "yesterday" };
  const date = new Date(iso);
  if (days < 7) return { kind: "date", text: new Intl.DateTimeFormat(locale, { timeZone, weekday: "short" }).format(date) };
  return { kind: "date", text: new Intl.DateTimeFormat(locale, { timeZone, day: "2-digit", month: "2-digit" }).format(date) };
}

/** A file's size in the reader's units: "240 ko", "3.4 MB". */
export function fileSize(bytes: number, locale: string): string {
  const [value, unit] =
    bytes >= 1_000_000_000
      ? [bytes / 1_000_000_000, "gigabyte"]
      : bytes >= 1_000_000
        ? [bytes / 1_000_000, "megabyte"]
        : [Math.max(bytes / 1000, 1), "kilobyte"];
  return new Intl.NumberFormat(locale, { style: "unit", unit, maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
}
