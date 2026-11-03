/**
 * Download links in the desktop app. The app's webview saves nothing by itself (a click on a
 * download link did nothing at all on Windows), so every click on one, the interface's own
 * `a.click()` included, is handed to the core: "Save as", or, for a link marked
 * `data-desktop-open` (the calendar's PDF), opened in the system's app for it, to print from there.
 */
import { downloadOpen, downloadSave } from "./bridge";
import { downloadName } from "./downloadName";
import { FILE_ERROR_EVENT } from "./files";

export type DownloadRequest = { href: string; name: string; open: boolean };

/** What a click asks for: a download link's address, the name to save under, and how. */
export function downloadOf(target: EventTarget | null): DownloadRequest | null {
  const element = target instanceof Element ? target : null;
  const link = element?.closest("a[download]");
  if (!(link instanceof HTMLAnchorElement)) return null;
  const href = link.getAttribute("href");
  if (!href) return null;
  return { href: link.href || href, name: downloadName(href, link.getAttribute("download")), open: link.dataset.desktopOpen !== undefined };
}

/** Catch the download links from now on; `onError` gets the core's code when one fails. */
export function catchDownloads(onError: (code: string) => void): () => void {
  const onClick = (event: MouseEvent) => {
    const request = downloadOf(event.target);
    if (!request) return;
    event.preventDefault();
    const done = request.open ? downloadOpen(request.href, request.name) : downloadSave(request.href, request.name);
    void done.catch((code: unknown) => onError(typeof code === "string" ? code : "failed"));
  };
  // A file the interface failed to open (a window, the computer's app) is told the same way.
  const onFileError = (event: Event) => onError(String((event as CustomEvent).detail ?? "failed"));
  document.addEventListener("click", onClick, true);
  window.addEventListener(FILE_ERROR_EVENT, onFileError);
  return () => {
    document.removeEventListener("click", onClick, true);
    window.removeEventListener(FILE_ERROR_EVENT, onFileError);
  };
}
