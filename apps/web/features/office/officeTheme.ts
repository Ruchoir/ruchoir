/**
 * The engine theme for this person: by night (any `-dark` Ruchoir theme), the engine's own dark
 * theme; otherwise the Ruchoir day theme. Read from what `<html>` shows, which already resolves the
 * "follow the device" setting.
 */
export function officeTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return (document.documentElement.getAttribute("data-theme") ?? "").endsWith("-dark") ? "dark" : "light";
}

/**
 * The person's accent (`sky`, `mint`, `violet`, `pink`): the first half of `data-theme` on `<html>`.
 * The editor paints with it what is selected or active, as Ruchoir does.
 */
export function officeAccent(): string {
  if (typeof document === "undefined") return "sky";
  return (document.documentElement.getAttribute("data-theme") ?? "").split("-")[0] || "sky";
}

/**
 * Whether this screen is driven by touch (a phone, a tablet): the engine then opens its own mobile
 * editor, made for fingers, rather than the desktop one with its ribbons.
 */
export function touchScreen(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(pointer: coarse)").matches;
}
