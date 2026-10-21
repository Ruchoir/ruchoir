/**
 * Whether this build is the desktop app's, and the few facts about it the interface needs.
 *
 * `NEXT_PUBLIC_RUCHOIR_TARGET` is written into the bundle at build time, so on the web `isDesktop` is
 * the constant `false` and everything behind it is dropped from the bundle.
 */

export const isDesktop: boolean = process.env.NEXT_PUBLIC_RUCHOIR_TARGET === "desktop";

export type DesktopOs = "windows" | "macos" | "linux";

/** The system the app runs on, read from the webview's user agent. */
export function desktopOs(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): DesktopOs {
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macos";
  return "linux";
}

/** The base URL of an instance on the app's own protocol (ADR 0008): its API is `/i/<id>/api/v1`. */
export function instanceBase(id: string): string {
  return `/i/${id}`;
}
