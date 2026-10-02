/**
 * The engine theme for this person: by night (any `-dark` Ruchoir theme), the engine's own dark
 * theme; otherwise the Ruchoir day theme. Read from what `<html>` shows, which already resolves the
 * "follow the device" setting.
 */
export function officeTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return (document.documentElement.getAttribute("data-theme") ?? "").endsWith("-dark") ? "dark" : "light";
}
