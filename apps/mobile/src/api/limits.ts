/**
 * The largest file the instance accepts, read once from `GET /instance` and kept for the session.
 * Unknown (an older instance, or no answer) means no check here: the server still refuses with a 413.
 */
import { getInstanceCapabilities } from "@ruchoir/client";

let limit: Promise<number | undefined> | null = null;

export function uploadLimit(): Promise<number | undefined> {
  limit ??= getInstanceCapabilities().then(
    (caps) => caps.uploadMaxBytes,
    () => {
      limit = null;
      return undefined;
    },
  );
  return limit;
}

/** Forget it, when the app moves to another instance. */
export function forgetUploadLimit(): void {
  limit = null;
}
