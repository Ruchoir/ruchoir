/**
 * The calendar screen's pure logic: days and periods in a time zone, which occurrences a filter
 * keeps, and where a day's events sit on its grid.
 *
 * It imports only the time maths shared with the apps (`@ruchoir/client/calendarLogic`), so it runs
 * as is under Node's test runner (`model.test.ts`), and every view (month, week, day, list, phone and
 * desktop) asks it the same questions.
 *
 * Days are written `YYYY-MM-DD` and instants as RFC 3339. A day is always a day of the viewer's time
 * zone, read with `Intl` so that a change of time (a 23- or 25-hour day) lands where it should.
 */

import { addDays, localDay, localMinutes, weekdayOf, zonedTime } from "@ruchoir/client/calendarLogic";

export { addDays, clashes, freeSlots, localDay, localMinutes, movedSeriesStart, weekdayOf, zonedTime } from "@ruchoir/client/calendarLogic";

/** Which calendars the screen shows in full: all of them, or one space's (and the viewer's own). */
export type Filter = { kind: "all" } | { kind: "space"; spaceId: string };

/** The views of the screen. */
export type View = "year" | "month" | "week" | "day" | "list";

/** How many days `day` is past the first day of its week, the week starting on `weekStart` (as
 *  `getUTCDay` counts: Sunday 0, Monday 1). */
export function weekOffset(day: string, weekStart = 1): number {
  return (weekdayOf(day) + 1 - weekStart + 7) % 7;
}

/** The period a view shows around `anchor`: a day, a week (from `weekStart`), a six-week month grid,
 *  or thirty days of list. */
export function rangeFor(view: View, anchor: string, tz: string, weekStart = 1): { from: string; to: string } {
  let first = anchor;
  let days = 1;
  if (view === "week") {
    first = addDays(anchor, -weekOffset(anchor, weekStart));
    days = 7;
  } else if (view === "month") {
    const monthStart = `${anchor.slice(0, 8)}01`;
    first = addDays(monthStart, -weekOffset(monthStart, weekStart));
    days = 42;
  } else if (view === "list") {
    days = 30;
  } else if (view === "year") {
    const year = Number(anchor.slice(0, 4));
    return { from: zonedTime(`${year}-01-01`, 0, tz), to: zonedTime(`${year + 1}-01-01`, 0, tz) };
  }
  return { from: zonedTime(first, 0, tz), to: zonedTime(addDays(first, days), 0, tz) };
}

/** The day a view shows next (`direction` 1) or before (-1): a day, a week, 30 days, the first of
 *  the next month or of the next year. */
export function stepAnchor(view: View, anchor: string, direction: 1 | -1): string {
  if (view === "day") return addDays(anchor, direction);
  if (view === "week") return addDays(anchor, 7 * direction);
  if (view === "list") return addDays(anchor, 30 * direction);
  const [y, m] = anchor.split("-").map(Number);
  if (view === "year") return `${y + direction}-01-01`;
  const next = new Date(Date.UTC(y, m - 1 + direction, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Whether an occurrence is shown in full under `filter`. A personal calendar always is, and so is
 *  an invitation the viewer did not decline; outside the filter, the others are drawn struck
 *  through, not hidden. */
export function inFilter(
  occurrence: { calendarId: string; myStatus?: string; invited?: boolean },
  calendars: ReadonlyArray<{ id: string; spaceId?: string }>,
  filter: Filter,
): boolean {
  // What the viewer is invited to and did not decline is theirs, wherever it comes from.
  if (occurrence.myStatus && occurrence.myStatus !== "declined") return true;
  const calendar = calendars.find((c) => c.id === occurrence.calendarId);
  if (!calendar) return false;
  if (!calendar.spaceId || filter.kind === "all") return true;
  return calendar.spaceId === filter.spaceId;
}

/** An event placed on a day's grid, in minutes from local midnight. */
export type Positioned<T> = { item: T; top: number; height: number; column: number; columns: number };

/** The shortest an event is drawn, in minutes, so a five-minute call can still be read and tapped:
 *  on the grid's 48 px hour, 25 minutes is the 20 px a one-line title needs. Overlaps are worked out
 *  on that drawn height, so two short events never cover each other. */
export const MIN_HEIGHT = 25;

/**
 * Where a day's timed events sit: their top and height in minutes, and, for events that overlap,
 * side by side columns sharing the width. An event running over midnight is cut to the part on this
 * day. All-day events are not laid out here (they go in the band above the grid).
 */
export function layoutDay<T extends { allDay: boolean; start: string; end: string }>(
  items: readonly T[],
  day: string,
  tz: string,
): Positioned<T>[] {
  const dayStart = Date.parse(zonedTime(day, 0, tz));
  const dayEnd = Date.parse(zonedTime(addDays(day, 1), 0, tz));
  const placed = items
    .filter((item) => !item.allDay)
    .map((item) => {
      const start = Date.parse(item.start);
      const end = Math.max(Date.parse(item.end), start);
      const from = Math.max(start, dayStart);
      const to = Math.min(end, dayEnd);
      const inside = start === end ? start >= dayStart && start < dayEnd : to > from;
      return { item, from, to, inside };
    })
    .filter((p) => p.inside)
    .sort((a, b) => a.from - b.from || b.to - a.to);

  const out: Positioned<T>[] = [];
  let cluster: Positioned<T>[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;
  const close = () => {
    for (const p of cluster) p.columns = columnEnds.length;
    out.push(...cluster);
    cluster = [];
    columnEnds = [];
  };
  for (const p of placed) {
    const shownEnd = Math.max(p.to, p.from + MIN_HEIGHT * 60_000);
    if (p.from >= clusterEnd) {
      close();
      clusterEnd = -Infinity;
    }
    let column = columnEnds.findIndex((end) => end <= p.from);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(shownEnd);
    } else {
      columnEnds[column] = shownEnd;
    }
    clusterEnd = Math.max(clusterEnd, shownEnd);
    const top = p.from === dayStart ? 0 : localMinutes(new Date(p.from).toISOString(), tz);
    cluster.push({
      item: p.item,
      top,
      height: Math.max(MIN_HEIGHT, Math.round((p.to - p.from) / 60_000)),
      column,
      columns: 0,
    });
  }
  close();
  return out;
}

/** Whether an occurrence touches a local day: an all-day one from its start date to the day before
 *  its end date, a timed one on every day from its start to just before its end. */
export function occursOn(occurrence: { allDay: boolean; start: string; end: string }, day: string, tz: string): boolean {
  if (occurrence.allDay) return occurrence.start <= day && day < occurrence.end;
  const first = localDay(occurrence.start, tz);
  const endAt = Date.parse(occurrence.end);
  const last = endAt > Date.parse(occurrence.start) ? localDay(new Date(endAt - 1).toISOString(), tz) : first;
  return first <= day && day <= last;
}

/** How many occurrences touch each local day, for the year's marks: a day of several days counts
 *  on each of them. */
export function busyDays(occurrences: ReadonlyArray<{ allDay: boolean; start: string; end: string }>, tz: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const o of occurrences) {
    const first = o.allDay ? o.start : localDay(o.start, tz);
    const endAt = Date.parse(o.end);
    const last = o.allDay
      ? addDays(o.end, -1)
      : endAt > Date.parse(o.start)
        ? localDay(new Date(endAt - 1).toISOString(), tz)
        : first;
    // A whole year at most: an occurrence never spans more, and a bad one never loops for long.
    for (let day = first, n = 0; day <= last && n < 366; day = addDays(day, 1), n++) {
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
  }
  return counts;
}

/** The colour a new calendar starts with: the pastel the viewer's calendars use least, ties going
 *  to the order the server hands them to new spaces. */
export function freeColor(calendars: ReadonlyArray<{ color: string }>): "mint" | "violet" | "peach" | "lime" | "sun" | "pink" | "sky" {
  const order = ["mint", "violet", "peach", "lime", "sun", "pink", "sky"] as const;
  const uses = (c: string) => calendars.filter((k) => k.color === c).length;
  return order.reduce((best, c) => (uses(c) < uses(best) ? c : best), order[0]);
}
