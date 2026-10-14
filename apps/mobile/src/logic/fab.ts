/**
 * When a tab's floating button shrinks to its icon: as soon as the list scrolls down (it then hides
 * less of what is read), back to its full label when the list scrolls up or comes back to its top.
 * A move of a few points either way changes nothing, so it does not flicker.
 */

/** Within this distance of the top, the button keeps its label. */
const TOP = 24;
/** A move smaller than this keeps the button as it is. */
const JITTER = 8;

export function fabCompact(compact: boolean, lastY: number, y: number): boolean {
  if (y <= TOP) return false;
  if (y - lastY > JITTER) return true;
  if (lastY - y > JITTER) return false;
  return compact;
}

/**
 * One scroll step: `anchor` is where the scroll last turned (the lowest point while the button is
 * shrunk, the highest while it is full), so many small steps add up.
 */
export function fabStep(state: { compact: boolean; anchor: number }, y: number): { compact: boolean; anchor: number } {
  const compact = fabCompact(state.compact, state.anchor, y);
  if (compact !== state.compact) return { compact, anchor: y };
  return { compact, anchor: compact ? Math.max(state.anchor, y) : Math.min(state.anchor, y) };
}
