/**
 * Files dropped outside any drop zone, in the desktop app. The window no longer hands drops to
 * Tauri's own handler (`disable_drag_drop_handler`, so the composer and the files list receive
 * them), which leaves the webview's default for a drop nobody took: it navigates to the file and
 * the interface is gone. This guard cancels that default, and only that one.
 */

/** Whether a drag or drop event carries files and no handler has claimed it. */
export function strayFileDrop(event: Pick<DragEvent, "defaultPrevented" | "dataTransfer">): boolean {
  if (event.defaultPrevented) return false;
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Listen on the window, in the bubbling phase, so the page's own handlers (the composer, the files
 * list) have run first and a drop they took is left alone.
 */
export function guardStrayDrops(): () => void {
  const cancel = (event: DragEvent) => {
    if (strayFileDrop(event)) event.preventDefault();
  };
  window.addEventListener("dragover", cancel);
  window.addEventListener("drop", cancel);
  return () => {
    window.removeEventListener("dragover", cancel);
    window.removeEventListener("drop", cancel);
  };
}
