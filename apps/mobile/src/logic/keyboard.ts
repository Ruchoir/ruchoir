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
