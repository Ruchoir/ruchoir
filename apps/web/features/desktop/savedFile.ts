import type { FileVersion } from "@ruchoir/client";
import type { DictKey } from "@/lib/i18n";

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

/** The words for a failed check or send: the core's codes, and "forbidden" and "signed_out" from either side. */
export function errorText(code: string, t: (key: DictKey) => string): string {
  switch (code) {
    case "too_large":
      return t("desktop.files.saved.tooLarge");
    case "busy":
      return t("desktop.files.saved.busy");
    case "signed_out":
      return t("desktop.download.signedOut");
    case "unreachable":
      return t("desktop.download.unreachable");
    case "forbidden":
      return t("files.uploadForbidden");
    case "not_watched":
      return t("desktop.files.saved.notWatched");
    default:
      return t("desktop.files.saved.failed");
  }
}

/** The code a failed read of the file's versions stands for. */
export function codeOfStatus(status: number | undefined): string {
  return status === 401 ? "signed_out" : status === 403 ? "forbidden" : "unreachable";
}
