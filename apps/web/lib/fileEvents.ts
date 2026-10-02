/**
 * File events, from the realtime connection to whichever screen shows files.
 *
 * The connection lives in `AppRoot`; the files screen and the office editor live further down and
 * come and go. Rather than thread callbacks through, `AppRoot` emits here and they listen while
 * mounted. Nothing is buffered: a screen that mounts later loads the current state from the API.
 */
import type { FileEditor, SpaceFile } from "@/lib/data/types";

export type FileEvent =
  | { type: "updated"; spaceId: string; file: SpaceFile }
  | { type: "editing"; spaceId: string; fileId: string; editors: FileEditor[] };

const listeners = new Set<(event: FileEvent) => void>();

export function emitFileEvent(event: FileEvent): void {
  for (const listener of listeners) listener(event);
}

/** Listen until the returned function is called. */
export function onFileEvent(listener: (event: FileEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
