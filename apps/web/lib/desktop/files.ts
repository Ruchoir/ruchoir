/**
 * Opening a file from the interface, in the desktop app: in a window of its own (the webview has no
 * tab to open a link in), or in the computer's app for it.
 *
 * The bridge is imported when a button is pressed, never at load: these helpers are reached from
 * components the web build shares, and Tauri's bindings must stay out of its bundle.
 */

import { isDesktop } from "@/lib/desktop/runtime";

/** The address the core is asked to open: absolute, on the app's own origin, path and query kept. */
export function openTarget(href: string, base: string = typeof location === "undefined" ? "http://localhost/" : location.href): string {
  return new URL(href, base).href;
}

/** The event a failed opening is reported on; `catchDownloads` shows it in the same dialog as a failed download. */
export const FILE_ERROR_EVENT = "ruchoir:desktop-file-error";

function report(code: unknown) {
  window.dispatchEvent(new CustomEvent(FILE_ERROR_EVENT, { detail: typeof code === "string" ? code : "failed" }));
}

/** Open `href` in a window of its own, titled with the file's name (an open one is brought forward). */
export async function openInWindow(href: string, name: string): Promise<void> {
  try {
    // `isDesktop` is a constant on the web build, which drops the import with it (and Tauri too).
    if (isDesktop) {
      const { fileWindow } = await import("@/lib/desktop/bridge");
      await fileWindow(openTarget(href), name);
    }
  } catch (code) {
    report(code);
  }
}

/** Open `href` in the computer's app for that kind of file. */
export async function openLocal(href: string, name: string): Promise<void> {
  try {
    // `isDesktop` is a constant on the web build, which drops the import with it (and Tauri too).
    if (isDesktop) {
      const { downloadOpen } = await import("@/lib/desktop/bridge");
      await downloadOpen(openTarget(href), name);
    }
  } catch (code) {
    report(code);
  }
}
