/**
 * The largest file an instance accepts, read once from `GET /instance` and kept while its client
 * lives. Unknown (an older instance, or no answer) means no check here: the server still refuses
 * with a 413.
 */
import type { RuchoirClient } from "@ruchoir/client";

const limits = new WeakMap<RuchoirClient, Promise<number | undefined>>();

export function uploadLimit(api: RuchoirClient): Promise<number | undefined> {
  let limit = limits.get(api);
  if (!limit) {
    limit = api.getInstanceCapabilities().then(
      (caps) => caps.uploadMaxBytes,
      () => {
        limits.delete(api);
        return undefined;
      },
    );
    limits.set(api, limit);
  }
  return limit;
}
