import type { FileVersion } from "@ruchoir/client";

/** What the core tells when an opened file was saved (`file:saved`). */
export type SavedFile = { instance: string; file_id: string; name: string; base_version: string };

/** Banners shown at once; older ones wait behind them and come forward as these are answered. */
export const VISIBLE_SAVED = 3;

/** One banner per file, per instance (two instances may hold the same file id). */
export const fileKey = (s: Pick<SavedFile, "instance" | "file_id">) => `${s.instance}/${s.file_id}`;

/** A save is the newest banner; one already shown for the same file is replaced, not stacked. */
export function pushSaved(list: SavedFile[], saved: SavedFile): SavedFile[] {
  return [saved, ...list.filter((s) => fileKey(s) !== fileKey(saved))];
}

/**
 * Whether the save can go up as it is: only when the file's current version is still the one it
 * was opened from. Anything else (someone added a version since, or the list is unreadable) is
 * asked about first, rather than put on top of work the person has not seen.
 */
export function choiceFor(current: FileVersion[], base: string): "send" | "ask" {
  return current.find((v) => v.current)?.id === base ? "send" : "ask";
}
