/**
 * When a tab's floating button shrinks to its icon: as soon as the list leaves its top, and for as
 * long as it is away from it, whether it scrolls on, stops, goes back up or bounces at its end; it
 * takes its label back only at the top, where nothing is under it yet.
 */

/** Within this distance of the top, the button keeps its label. */
const TOP = 24;

export function fabCompact(y: number): boolean {
  return y > TOP;
}
