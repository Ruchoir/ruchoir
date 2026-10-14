/**
 * Where the availability strip of the event form draws things (the web's `AvailabilityStrip`): the
 * part of the day shown, the working day around the event with an hour on either side, and each
 * busy time as a fraction of it. Instants in milliseconds, `dayStart` the local midnight.
 */

/** The hours drawn: from 7:00 at the latest, to 20:00 at the earliest, an hour around the event. */
export function stripWindow(dayStart: number, from: number, to: number): { first: number; last: number } {
  const hourOf = (at: number) => (at - dayStart) / 3_600_000;
  return {
    first: Math.max(0, Math.min(7, Math.floor(hourOf(from)) - 1)),
    last: Math.min(24, Math.max(20, Math.ceil(hourOf(to)) + 1)),
  };
}

/** Where `[a, b)` sits on the strip, as fractions of its width, cut to the hours drawn. */
export function placeOnStrip(dayStart: number, a: number, b: number, window: { first: number; last: number }): { left: number; width: number } {
  const span = window.last - window.first;
  const at = (t: number) => (Math.min(Math.max((t - dayStart) / 3_600_000, window.first), window.last) - window.first) / span;
  return { left: at(a), width: at(b) - at(a) };
}

/** Whether busy times overlap `[from, to)`; touching ends do not. */
export function busyDuring(busy: readonly { start: string; end: string }[], from: number, to: number): boolean {
  return busy.some((b) => Date.parse(b.start) < to && from < Date.parse(b.end));
}
