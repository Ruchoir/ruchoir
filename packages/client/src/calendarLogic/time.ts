/**
 * Days and instants in a time zone, as a calendar needs them: a day's midnight, the day and wall
 * time of an instant, a series moved by wall clock, what an event overlaps, and free slots.
 *
 * Shared by the web and the apps. Nothing here imports anything, on purpose: the module runs as is
 * under Node's test runner (`test/calendarTime.test.ts`).
 *
 * Days are written `YYYY-MM-DD` and instants as RFC 3339. A day is always a day of the viewer's time
 * zone, read with `Intl` so that a change of time (a 23- or 25-hour day) lands where it should.
 */

const DAY_MS = 86_400_000;

/** The wall clock of `tz` at an instant, as numbers. */
function wallClock(at: number, tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  // Read, never shown: a fixed language keeps the digits and the 24-hour clock predictable.
  // i18n-audit-ignore-next-line
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** How far ahead of UTC `tz` is at an instant, in milliseconds. */
function offsetAt(at: number, tz: string): number {
  const w = wallClock(at, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(at / 1000) * 1000;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dayParts(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y, m, d];
}

/** The day `n` days after `day`. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = dayParts(day);
  const at = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** Monday 0 to Sunday 6. */
export function weekdayOf(day: string): number {
  const [y, m, d] = dayParts(day);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The instant at which the wall clock of `tz` shows `minutes` past midnight on `day`. */
export function zonedTime(day: string, minutes: number, tz: string): string {
  const [y, m, d] = dayParts(day);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let at = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(at, tz);
  if (second !== at) at = second;
  return new Date(at).toISOString();
}

/** The day of `tz` an instant falls on. */
export function localDay(at: string, tz: string): string {
  const w = wallClock(Date.parse(at), tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Minutes past local midnight of an instant in `tz`. */
export function localMinutes(at: string, tz: string): number {
  const w = wallClock(Date.parse(at), tz);
  return w.hour * 60 + w.minute;
}

/** Where a whole series' first occurrence (`seriesStart`) goes when one of its occurrences is moved
 *  from `from` to `to`: by the same change of wall clock in `tz` (days and time of day), so a series
 *  whose dates fall on both sides of a change of clock keeps its local time. */
export function movedSeriesStart(seriesStart: string, from: string, to: string, tz: string): string {
  const wall = (at: string) => {
    const [y, m, d] = dayParts(localDay(at, tz));
    return Date.UTC(y, m - 1, d) / 60_000 + localMinutes(at, tz);
  };
  const minutes = wall(seriesStart) + (wall(to) - wall(from));
  const day = Math.floor(minutes / 1440);
  const at = new Date(day * DAY_MS);
  const date = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  return zonedTime(date, minutes - day * 1440, tz);
}

/**
 * What a new or changed event overlaps, whatever the calendar: `ours` as instants (an all-day event
 * as the midnights of its zone), `exclude` the event being edited. Touching ends do not clash.
 */
export function clashes<T extends { eventId: string; allDay: boolean; start: string; end: string }>(
  found: readonly T[],
  ours: { start: string; end: string },
  tz: string,
  exclude?: string,
): T[] {
  const from = Date.parse(ours.start);
  const to = Date.parse(ours.end);
  return found.filter((o) => {
    if (o.eventId === exclude) return false;
    const start = Date.parse(o.allDay ? zonedTime(o.start, 0, tz) : o.start);
    const end = Date.parse(o.allDay ? zonedTime(o.end, 0, tz) : o.end);
    return start < to && from < end;
  });
}

/**
 * Up to `limit` slots of `duration` minutes when nobody in `busy` is taken, from `from` on, over
 * `days` days: within `[dayStart, dayEnd)` hours of `tz`, on the half hour, without Saturday and
 * Sunday unless `weekends`. The slots proposed do not overlap one another.
 */
export function freeSlots(
  busy: ReadonlyArray<{ start: string; end: string }>,
  opts: { from: string; days: number; duration: number; dayStart: number; dayEnd: number; weekends: boolean; tz: string; limit?: number },
): { start: string; end: string }[] {
  const limit = opts.limit ?? 3;
  const from = Date.parse(opts.from);
  const taken = busy.map((b) => [Date.parse(b.start), Date.parse(b.end)] as const);
  const found: { start: string; end: string }[] = [];
  const first = localDay(opts.from, opts.tz);
  for (let d = 0; d < opts.days && found.length < limit; d += 1) {
    const day = addDays(first, d);
    if (!opts.weekends && weekdayOf(day) >= 5) continue;
    let minutes = opts.dayStart * 60;
    while (minutes + opts.duration <= opts.dayEnd * 60 && found.length < limit) {
      const start = Date.parse(zonedTime(day, minutes, opts.tz));
      const end = start + opts.duration * 60_000;
      if (start >= from && !taken.some(([a, b]) => a < end && start < b)) {
        found.push({ start: new Date(start).toISOString().replace(".000Z", "Z"), end: new Date(end).toISOString().replace(".000Z", "Z") });
        minutes += opts.duration;
      } else {
        minutes += 30;
      }
    }
  }
  return found;
}
