/**
 * How much of a view the keyboard covers, both measured in the window.
 *
 * React Native's `KeyboardAvoidingView` compares its own position, taken relative to its parent,
 * with the keyboard's, taken in the window: under a header the two disagree by the header's height,
 * and the composer stays hidden. `ui/KeyboardArea` measures itself in the window and uses this.
 */
export function keyboardOverlap(frame: { y: number; height: number }, keyboardTop: number): number {
  return Math.max(0, frame.y + frame.height - keyboardTop);
}

/** Room kept between a field and the edge it is brought next to. */
const REVEAL_MARGIN = 16;

/**
 * Where a form should scroll to so the focused field shows, both measured in the window: the field
 * brought just above the bottom of the visible part (the keyboard's edge) or just under its top,
 * with some room. Null when it shows already.
 */
export function revealOffset(field: { y: number; height: number }, visible: { y: number; height: number }, offset: number): number | null {
  const below = field.y + field.height + REVEAL_MARGIN - (visible.y + visible.height);
  if (below > 0) return offset + below;
  const above = visible.y - (field.y - REVEAL_MARGIN);
  if (above > 0) return Math.max(0, offset - above);
  return null;
}
