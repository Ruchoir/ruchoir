/**
 * What the Android widgets show, computed from the instance's answers (step 6e): the next events and
 * the unread count. The iPhone's widgets do the same in Swift (`targets/widgets`). Free of React
 * Native so Node tests it.
 */

/** An occurrence as `GET /api/v1/calendar/occurrences` returns it, the fields used here. */
export type WireEvent = { title: string; location?: string | null; all_day: boolean; start: string; end: string };

/** The events not over yet at `now`, soonest first, at most `limit`. */
export function upcoming(events: WireEvent[], now: Date, limit: number): WireEvent[] {
  return events
    .filter((e) => new Date(e.end).getTime() > now.getTime())
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, limit);
}

export type StartsIn = { kind: "now" } | { kind: "minutes"; n: number } | { kind: "hours"; n: number } | { kind: "later" };

/** "now", "in 20 min", "in 2 h", or later than that (the day and time say it then). */
export function startsIn(start: Date, now: Date): StartsIn {
  const minutes = Math.round((start.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return { kind: "now" };
  if (minutes < 60) return { kind: "minutes", n: minutes };
  if (minutes < 24 * 60) return { kind: "hours", n: Math.round(minutes / 60) };
  return { kind: "later" };
}

/** The unread messages of every space, as `GET /api/v1/me/spaces` counts them. */
export function unreadTotal(spaces: { unread?: number }[]): number {
  return spaces.reduce((sum, space) => sum + (space.unread ?? 0), 0);
}
