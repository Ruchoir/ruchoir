/**
 * Fetch a file into the app's cache (with the bearer), once: a file already there is opened again
 * without a request. The cache is emptied at sign-out (`cache.ts`).
 */
import type { RuchoirClient } from "@ruchoir/client";
import { File } from "expo-file-system";

import { authHeadersFor } from "../api/useApi";
import type { ViewerFile } from "../navigation/types";
import { downloadsDirectory } from "./cache";

/** A name safe on any file system, keeping the extension that tells the viewer what it holds. */
function safeName(file: ViewerFile): string {
  const name = file.name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(-120) || "file";
  return `${file.id.replace(/[^\w-]/g, "")}-${name}`;
}

export async function downloadToCache(api: RuchoirClient, file: ViewerFile, signal?: AbortSignal): Promise<string> {
  const target = new File(downloadsDirectory(api.options().baseUrl), safeName(file));
  if (target.exists && target.size > 0) return target.uri;
  const url = api.absoluteUrl(file.url);
  const done = await File.downloadFileAsync(url, target, { headers: authHeadersFor(api, url), idempotent: true, signal });
  return done.uri;
}
