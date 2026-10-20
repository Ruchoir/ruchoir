/**
 * What `DesktopEntry` resolves to in the web build (`next.config.mjs`): nothing. The page never
 * renders it there (`isDesktop` is false), and this keeps the desktop's code and its Tauri bindings
 * out of the web bundle altogether, instead of shipping a chunk nobody loads.
 */
export function DesktopEntry() {
  return null;
}
