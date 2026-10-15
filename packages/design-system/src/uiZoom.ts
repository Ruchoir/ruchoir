/**
 * Effective UI zoom: the text-size scale applied as `zoom` on `:root` (see globals.css, `--ui-zoom`).
 *
 * Floating layers (Popover, Tooltip) are portaled into `document.body`, which lives inside the zoomed
 * root, so `getBoundingClientRect()` reports visual (already-zoomed) coordinates while a fixed
 * element's `top`/`left` are re-scaled by the zoom at paint. Positioners divide measured rects and the
 * viewport by this factor to work in unzoomed layout space, so the coordinates they set render where
 * intended. Returns 1 when no zoom is set (the default text size) or off the client.
 */
export function uiZoom(): number {
  if (typeof document === "undefined") return 1;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--ui-zoom");
  const z = parseFloat(raw);
  return z > 0 ? z : 1;
}
