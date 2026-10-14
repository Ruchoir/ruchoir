/**
 * The calendar arithmetic behind the agenda (mockups 15 to 17), on day keys (`YYYY-MM-DD`).
 *
 * Weeks start on Monday unless the person chose Sunday or Saturday (`WeekStart`, as `Date.getDay()`
 * numbers it). Day keys are plain dates, so the
 * arithmetic runs in UTC where a day is always 24 hours; the reader's zone only matters when an
 * instant is turned into a day, which `dayKey` does.
 */
import type { Occurrence } from "@ruchoir/client";

import { dayKey } from "./format.ts";

export type AgendaView = "list" | "week" | "month";

const DAY_MS = 86_400_000;
const toTime = (day: string) => Date.parse(`${day}T00:00:00Z`);
const fromTime = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return fromTime(toTime(day) + n * DAY_MS);
}

/** The first day of a week: 1 Monday, 0 Sunday, 6 Saturday. */
export type WeekStart = 1 | 0 | 6;

/** How many days into its week a day falls, the week starting on `weekStart`. */
function weekday(day: string, weekStart: WeekStart = 1): number {
  return (new Date(toTime(day)).getUTCDay() - weekStart + 7) % 7;
}

/** The seven days of the week a day falls in, from the first day of the week. */
export function weekOf(day: string, weekStart: WeekStart = 1): string[] {
  const first = addDays(day, -weekday(day, weekStart));
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/**
 * The weekdays in the order a week shows them, each as its place in a Monday-first week (Monday 0):
 * how a list of weekday names written Monday first is read for another first day.
 */
export function weekdayOrder(weekStart: WeekStart = 1): number[] {
  const offset = (weekStart + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => (offset + i) % 7);
}

/** A month (`YYYY-MM`) as weeks of seven, padded with `null` before the 1st and after the last day. */
export function monthGrid(month: string, weekStart: WeekStart = 1): (string | null)[][] {
  const first = `${month}-01`;
  const days: (string | null)[] = Array.from({ length: weekday(first, weekStart) }, () => null);
  for (let day = first; day.startsWith(month); day = addDays(day, 1)) days.push(day);
  while (days.length % 7) days.push(null);
  return Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));
}

/** The occurrences of each day, in order: all-day ones first, then by start. */
export function groupByDay<O extends Pick<Occurrence, "start" | "end" | "allDay">>(
  occurrences: O[],
  timeZone: string,
): { day: string; items: O[] }[] {
  const byDay = new Map<string, O[]>();
  const add = (day: string, o: O) => {
    const list = byDay.get(day) ?? [];
    list.push(o);
    byDay.set(day, list);
  };
  for (const o of occurrences) {
    if (o.allDay) {
      // The end of an all-day event is exclusive: 20 to 22 is the 20th and the 21st.
      const end = o.end > o.start ? o.end.slice(0, 10) : addDays(o.start.slice(0, 10), 1);
      for (let day = o.start.slice(0, 10); day < end; day = addDays(day, 1)) add(day, o);
    } else {
      const first = dayKey(o.start, timeZone);
      // An event running past midnight shows on the days it reaches, not on the one it ends at 00:00.
      const last = dayKey(new Date(Math.max(Date.parse(o.start), Date.parse(o.end) - 1)), timeZone);
      for (let day = first; day <= last; day = addDays(day, 1)) add(day, o);
    }
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, items]) => ({
      day,
      items: items.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start)),
    }));
}

/**
 * What to ask the API for: the days on screen with one day of margin each side, so an event that
 * belongs to an edge day in the reader's zone is not cut off by UTC.
 */
export function rangeForView(view: AgendaView, anchor: string, weekStart: WeekStart = 1): { from: string; to: string } {
  let first: string;
  let last: string;
  if (view === "week") {
    const week = weekOf(anchor, weekStart);
    [first, last] = [week[0], week[6]];
  } else if (view === "month") {
    const month = anchor.slice(0, 7);
    first = `${month}-01`;
    last = addDays(`${shiftMonth(month, 1)}-01`, -1);
  } else {
    [first, last] = [anchor, addDays(anchor, 30)];
  }
  return { from: `${addDays(first, -1)}T00:00:00Z`, to: `${addDays(last, 2)}T00:00:00Z` };
}

function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** The next or previous period: a week (or a list's month) by days, a month to its 1st. */
export function shiftAnchor(view: AgendaView, anchor: string, direction: 1 | -1): string {
  if (view === "month") return `${shiftMonth(anchor.slice(0, 7), direction)}-01`;
  return addDays(anchor, direction * (view === "week" ? 7 : 30));
}
