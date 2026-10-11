/**
 * Reminders as the screen says them: their delays, their words, and a delay of one's own.
 *
 * A delay is a number of minutes before a timed event's start; for a whole day, before the local
 * midnight that starts it (`420` the evening before at 17:00, `-540` the same morning at 9:00,
 * `N * 1440 - 540` N days before at 9:00). Imports nothing at run time, so Node's test runner runs
 * it as is (`reminders.test.ts`).
 */

import type { Translate } from "@/lib/i18n";

/** The most reminders one event, or one calendar, carries. */
export const MAX_REMINDERS = 5;

/** The furthest a timed event is reminded ahead: four weeks. */
export const MAX_LEAD_MINUTES = 40_320;

/** The delays offered at once for a timed event. */
export const TIMED_REMINDERS = [0, 5, 10, 15, 30, 60, 1440] as const;

/** And for a whole day: the evening before at 17:00, the same morning at 9:00. */
export const ALL_DAY_REMINDERS = [420, -540] as const;

/** The units of a delay of one's own. A whole day counts in days only. */
export type ReminderUnit = "minutes" | "hours" | "days" | "weeks";

const UNIT_MINUTES: Record<ReminderUnit, number> = { minutes: 1, hours: 60, days: 1440, weeks: 10_080 };

/** How a delay reads: "10 min avant", "2 sem. avant", "La veille à 17 h", "3 jours avant à 9 h". */
export function reminderLabel(minutes: number, t: Translate, allDay = false): string {
  if (allDay) {
    if (minutes === 420) return t("calendar.reminderEve");
    if (minutes === -540) return t("calendar.reminderMorning");
    if ((minutes + 540) % 1440 === 0) return t("calendar.reminderDaysAt9", { count: (minutes + 540) / 1440 });
  }
  if (minutes === 0) return t("calendar.reminderAtStart");
  if (minutes % 10_080 === 0) return t("calendar.reminderWeeks", { count: minutes / 10_080 });
  if (minutes % 1440 === 0) return t("calendar.reminderDays", { count: minutes / 1440 });
  if (minutes % 60 === 0) return t("calendar.reminderHours", { count: minutes / 60 });
  return t("calendar.reminderMinutes", { count: minutes });
}

/** A list of delays in a line, or "no reminder". */
export function remindersLabel(minutes: readonly number[], t: Translate, allDay = false): string {
  return minutes.length === 0 ? t("calendar.reminderNone") : minutes.map((m) => reminderLabel(m, t, allDay)).join(", ");
}

/** The delay of `count` units before, or `null` when it is not one the server keeps. A whole day
 *  counts days before, at 9:00, from one to 28. */
export function customMinutes(count: number, unit: ReminderUnit, allDay: boolean): number | null {
  if (!Number.isInteger(count) || count < 0) return null;
  if (allDay) return count >= 1 && count <= 28 ? count * 1440 - 540 : null;
  const minutes = count * UNIT_MINUTES[unit];
  return minutes <= MAX_LEAD_MINUTES ? minutes : null;
}

/** The delays offered at once for an event of this kind. */
export function presetReminders(allDay: boolean): readonly number[] {
  return allDay ? ALL_DAY_REMINDERS : TIMED_REMINDERS;
}

/** Whether two choices of reminders are the same: the same delays in any order, or both following
 *  the calendar (`undefined`), which is not the same as choosing none. */
export function sameReminders(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((m) => b.includes(m));
}
