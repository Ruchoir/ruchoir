/**
 * Days and times of the event form as the phone's pickers and the screen take them. A picker works
 * on the phone's own clock: a day is handed to it as that day at noon, a time as that time on a
 * fixed day, and read back from the same local fields, so no time zone ever shifts them.
 */
import { hhmm, minutesOf, type EventDraft, type WhenField } from "../../../logic/eventForm.ts";

const pad = (n: number) => String(n).padStart(2, "0");

/** The value a picker opens on for `field`. */
export function whenDate(d: EventDraft, field: WhenField): Date {
  if (field === "startDay" || field === "endDay") {
    const [y, m, day] = d[field].split("-").map(Number);
    return new Date(y, m - 1, day, 12);
  }
  const minutes = minutesOf(d[field]);
  return new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
}

/** What a picker handed back, as the draft writes it: `YYYY-MM-DD` or `HH:MM`. */
export function fromPicked(date: Date, field: WhenField): string {
  if (field === "startDay" || field === "endDay") return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return hhmm(date.getHours() * 60 + date.getMinutes());
}

/** "Mercredi 14 octobre 2026". */
export function longDay(day: string, locale: string): string {
  const text = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(
    new Date(`${day}T12:00:00Z`),
  );
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/** "Mer. 14 oct. 2026": a day short enough to sit beside its time on one line. */
export function mediumDay(day: string, locale: string): string {
  const text = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(
    new Date(`${day}T12:00:00Z`),
  );
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/** A wall time as the language writes it: "09:05", "9:05 AM". */
export function clockLabel(value: string, locale: string): string {
  const minutes = minutesOf(value);
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", hour: "2-digit", minute: "2-digit" }).format(
    new Date(Date.UTC(2000, 0, 1, Math.floor(minutes / 60), minutes % 60)),
  );
}

/** Whether the language counts hours to 24 (the time picker follows it). */
export function uses24h(locale: string): boolean {
  const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h23" || cycle === "h24";
}
