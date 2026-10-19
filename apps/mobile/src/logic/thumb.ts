/**
 * The box a message's picture is drawn in: as wide as the column allows up to `maxWidth`, as high as
 * its proportions ask up to `maxHeight` (a tall picture then gets narrower), so the whole picture
 * shows, never cropped. Computed in points from the column's measured width rather than with a
 * percentage and an aspect ratio, which drew a narrow, cropped strip in the tablet's side pane.
 * Free of React Native so Node tests it.
 */
export function thumbBox(
  column: number,
  width: number | undefined,
  height: number | undefined,
  maxWidth = 300,
  maxHeight = 320,
): { width: number; height: number } {
  const ratio = width && height ? width / height : 4 / 3;
  let w = Math.max(0, Math.min(column, maxWidth));
  let h = w / ratio;
  if (h > maxHeight) {
    h = maxHeight;
    w = h * ratio;
  }
  return { width: Math.round(w), height: Math.round(h) };
}
