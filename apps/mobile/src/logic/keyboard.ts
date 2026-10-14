/**
 * The room a `KeyboardArea` keeps at its bottom: `rest` while the keyboard is down (the home
 * indicator's area, or none), then the keyboard's height once it reaches that far, less `overlap`,
 * the part of the area that may go behind it (a composer's own room for the home indicator).
 *
 * Every keyboard area reaches the bottom of its screen, so the keyboard always covers exactly its
 * height of it. Positions are not compared: React Native's `KeyboardAvoidingView` measures itself
 * against its parent and under-raises below a header, and a view's place in the window is reported
 * without the offset of the sheet it is in, which under-raised the group form by that offset.
 */
export function areaPadding(keyboardHeight: number, rest: number, overlap = 0): number {
  // Run on the UI thread too, frame by frame as the keyboard moves (see `ui/KeyboardArea`).
  "worklet";
  return Math.max(rest, keyboardHeight - overlap);
}

/** The gap between a composer's bar and the keyboard above which it stands. */
export const COMPOSER_GAP = 8;

/** The room under a composer's bar: clear of the home indicator, or `COMPOSER_GAP` without one. */
export function composerRoom(safeBottom: number): number {
  "worklet";
  return Math.max(COMPOSER_GAP, safeBottom);
}

/**
 * Where a `KeyboardArea` stands as the keyboard moves: `padding` lays it out above the keyboard,
 * `shift` slides it there. An area that `slide`s only slides while the keyboard is `moving`, and is
 * laid out again once it rests: laying a chat's list out at every frame re-renders it at every frame,
 * and Reanimated holds its own updates while React commits, so the composer fell behind the keyboard.
 */
export function areaPlacement(
  keyboardHeight: number,
  rest: number,
  overlap: number,
  slide: boolean,
  moving: boolean,
): { padding: number; shift: number } {
  "worklet";
  const padding = areaPadding(keyboardHeight, rest, overlap);
  return slide && moving ? { padding: rest, shift: rest - padding } : { padding, shift: 0 };
}
