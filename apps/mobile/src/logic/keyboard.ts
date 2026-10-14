/**
 * The room a `KeyboardArea` keeps at its bottom: all of the keyboard while it is up, else the home
 * indicator's area when the area runs to the bottom of the screen.
 *
 * Every keyboard area reaches the bottom of its screen, so the keyboard always covers exactly its
 * height of it. Positions are not compared: React Native's `KeyboardAvoidingView` measures itself
 * against its parent and under-raises below a header, and a view's place in the window is reported
 * without the offset of the sheet it is in, which under-raised the group form by that offset.
 */
export function areaPadding(keyboardHeight: number, safeBottom: number): number {
  // Run on the UI thread too, frame by frame as the keyboard moves (see `ui/KeyboardArea`).
  "worklet";
  return keyboardHeight > 0 ? keyboardHeight : safeBottom;
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
