/**
 * Opening a file from the interface, in the desktop app: in a window of its own (the webview has no
 * tab to open a link in), or in the computer's app for it.
 *
 * The bridge is imported when a button is pressed, never at load: these helpers are reached from
 * components the web build shares, and Tauri's bindings must stay out of its bundle.
 */

import { isDesktop } from "./runtime.ts";

/** The address the core is asked to open: absolute, on the app's own origin, path and query kept. */
export function openTarget(href: string, base: string = typeof location === "undefined" ? "http://localhost/" : location.href): string {
  return new URL(href, base).href;
}

/** The event a failed opening is reported on; `catchDownloads` shows it in the same dialog as a failed download. */
export const FILE_ERROR_EVENT = "ruchoir:desktop-file-error";

function report(code: unknown, prefix = "") {
  window.dispatchEvent(new CustomEvent(FILE_ERROR_EVENT, { detail: `${prefix}${typeof code === "string" ? code : "failed"}` }));
}

let installed: EventListener | null = null;

/**
 * Hear failed openings. One listener at most: a second call replaces the first, so installing twice
 * (a remount, a hot reload) does not show the dialog twice. Returns the way to stop listening.
 */
export function listenFileErrors(onError: (code: string) => void): () => void {
  if (installed) window.removeEventListener(FILE_ERROR_EVENT, installed);
  const handler: EventListener = (event) => onError(String((event as CustomEvent).detail ?? "failed"));
  installed = handler;
  window.addEventListener(FILE_ERROR_EVENT, handler);
  return () => {
    window.removeEventListener(FILE_ERROR_EVENT, handler);
    if (installed === handler) installed = null;
  };
}

/** Open `href` in a window of its own, titled with the file's name (an open one is brought forward). */
export async function openInWindow(href: string, name: string): Promise<void> {
  try {
    // `isDesktop` is a constant on the web build, which drops the import with it (and Tauri too).
    if (isDesktop) {
      const { fileWindow } = await import("./bridge");
      await fileWindow(openTarget(href), name);
    }
  } catch (code) {
    report(code, "file:");
  }
}

/**
 * Open a file in the computer's app for it. When the person may replace the file (`canVersion`),
 * its current version is read first and handed to the core, which then watches the copy: the version
 * is what a later save is compared with before it is offered as a new one. A version list that
 * cannot be read opens the file all the same, unwatched, rather than refusing to open it.
 */
export async function openLocal(file: {
  instance: string;
  /** Absent for a file that is only a link (a message still uploading): opened as a plain download. */
  fileId?: string;
  name: string;
  /** The file's own download link, which is what the core accepts for a watched file. */
  href: string;
  canVersion?: boolean;
}): Promise<void> {
  try {
    // `isDesktop` is a constant on the web build, which drops the import with it (and Tauri too).
    if (isDesktop) {
      if (!file.fileId) {
        const { downloadOpen } = await import("./bridge");
        await downloadOpen(openTarget(file.href), file.name);
        return;
      }
      let baseVersion: string | undefined;
      let unwatched = false;
      if (file.canVersion) {
        try {
          // Loaded here, as the bridge is: the node tests import this file without the app's aliases.
          const { getVersions } = await import("@/lib/data/api");
          baseVersion = (await getVersions(file.fileId)).find((v) => v.current)?.id;
        } catch {
          baseVersion = undefined;
          unwatched = true;
        }
      }
      const { fileOpenLocal } = await import("./bridge");
      await fileOpenLocal(file.instance, file.fileId, file.name, openTarget(file.href), baseVersion);
      // Opened, but a save will not be offered: said once, softly, through the same notice as a failure.
      if (unwatched) report("unwatched", "file:");
    }
  } catch (code) {
    report(code, "file:");
  }
}
