/**
 * The files being sent, app-wide.
 *
 * A module-level store rather than a component's state, so sending survives what the person does
 * meanwhile: another folder, another space's conversation, the preferences. The upload panel reads it
 * with `useSyncExternalStore`; the files list hears each file that lands through `onUploadDone`.
 *
 * Three files go at once, the rest wait their turn. Leaving the page while one is under way asks
 * first.
 */

import type { SpaceFile } from "@/lib/data";
import { sendFile, type UploadRequest } from "@/lib/data/api";
import { isApiError } from "@/lib/data/http";

/** How many files are sent at the same time. */
const PARALLEL = 3;

export type UploadStatus = "queued" | "uploading" | "done" | "failed" | "cancelled";
/** Why a file did not go: too large, not allowed, the connection, or anything else. */
export type UploadFailure = "tooLarge" | "forbidden" | "network" | "server";

export type UploadJob = {
  id: string;
  /** The name it is sent under (a duplicate kept beside its original has its number). */
  name: string;
  size: number;
  spaceId: string;
  folderId?: string;
  /** Sent as a new version of this file rather than as a new file. */
  replaceFileId?: string;
  status: UploadStatus;
  /** Bytes gone so far. */
  loaded: number;
  failure?: UploadFailure;
};

type Entry = { job: UploadJob; file: File; request?: UploadRequest };

let entries: Entry[] = [];
let snapshot: UploadJob[] = [];
const listeners = new Set<() => void>();
const doneListeners = new Set<(job: UploadJob, file: SpaceFile) => void>();
let counter = 0;

function emit() {
  snapshot = entries.map((e) => e.job);
  for (const l of listeners) l();
  guardUnload();
}

function update(id: string, patch: Partial<UploadJob>) {
  entries = entries.map((e) => (e.job.id === id ? { ...e, job: { ...e.job, ...patch } } : e));
  emit();
}

/** What to send, and where. */
export type UploadInput = { file: File; name: string; spaceId: string; folderId?: string; replaceFileId?: string };

/** Queue files for sending. */
export function enqueue(inputs: UploadInput[]) {
  for (const input of inputs) {
    entries.push({
      file: input.file,
      job: {
        id: `u${++counter}`,
        name: input.name,
        size: input.file.size,
        spaceId: input.spaceId,
        folderId: input.folderId,
        replaceFileId: input.replaceFileId,
        status: "queued",
        loaded: 0,
      },
    });
  }
  emit();
  pump();
}

/** List a file that will not be sent, with the reason (too large, found before sending). */
export function reject(input: UploadInput, failure: UploadFailure) {
  entries.push({
    file: input.file,
    job: { id: `u${++counter}`, name: input.name, size: input.file.size, spaceId: input.spaceId, folderId: input.folderId, status: "failed", loaded: 0, failure },
  });
  emit();
}

/** Start as many waiting files as there is room for. */
function pump() {
  const running = entries.filter((e) => e.job.status === "uploading").length;
  const waiting = entries.filter((e) => e.job.status === "queued").slice(0, Math.max(0, PARALLEL - running));
  for (const entry of waiting) start(entry);
}

function start(entry: Entry) {
  const { job } = entry;
  const request = sendFile(
    { spaceId: job.spaceId, folderId: job.folderId, name: job.name, replaceFileId: job.replaceFileId },
    entry.file,
    (loaded) => update(job.id, { loaded }),
  );
  entries = entries.map((e) => (e.job.id === job.id ? { ...e, request, job: { ...e.job, status: "uploading", loaded: 0 } } : e));
  emit();
  request.done
    .then((file) => {
      update(job.id, { status: "done", loaded: job.size });
      const finished = entries.find((e) => e.job.id === job.id)?.job;
      if (finished) for (const l of doneListeners) l(finished, file);
    })
    .catch((err) => {
      if (err instanceof DOMException && err.name === "AbortError") {
        update(job.id, { status: "cancelled" });
      } else {
        const failure: UploadFailure = isApiError(err, 413)
          ? "tooLarge"
          : isApiError(err, 403)
            ? "forbidden"
            : isApiError(err, 0)
              ? "network"
              : "server";
        update(job.id, { status: "failed", failure });
      }
    })
    .finally(pump);
}

/** Stop a file: taken out of the queue, or its sending aborted. */
export function cancel(id: string) {
  const entry = entries.find((e) => e.job.id === id);
  if (!entry) return;
  if (entry.job.status === "uploading") entry.request?.abort();
  else if (entry.job.status === "queued") update(id, { status: "cancelled" });
}

/** Stop everything still waiting or under way. */
export function cancelAll() {
  for (const e of entries) if (e.job.status === "queued" || e.job.status === "uploading") cancel(e.job.id);
}

/** Send a file again after a failure or a cancellation (a file too large stays too large). */
export function retry(id: string) {
  const entry = entries.find((e) => e.job.id === id);
  if (!entry || entry.job.failure === "tooLarge") return;
  if (entry.job.status !== "failed" && entry.job.status !== "cancelled") return;
  update(id, { status: "queued", loaded: 0, failure: undefined });
  pump();
}

/** Forget what is over (sent, failed, cancelled); what is under way stays. */
export function clearFinished() {
  entries = entries.filter((e) => e.job.status === "queued" || e.job.status === "uploading");
  emit();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): UploadJob[] {
  return snapshot;
}

const EMPTY: UploadJob[] = [];
/** The server render (the static export) has nothing being sent. */
export function getServerSnapshot(): UploadJob[] {
  return EMPTY;
}

/** Hear every file that lands, to show it in the list it went to. */
export function onUploadDone(listener: (job: UploadJob, file: SpaceFile) => void): () => void {
  doneListeners.add(listener);
  return () => doneListeners.delete(listener);
}

/** Whether anything is still waiting or under way. */
export function isBusy(): boolean {
  return entries.some((e) => e.job.status === "queued" || e.job.status === "uploading");
}

// Leaving the page mid-send loses the rest: the browser asks first (its own words, not ours).
let guarding = false;
function beforeUnload(e: BeforeUnloadEvent) {
  e.preventDefault();
}
function guardUnload() {
  if (typeof window === "undefined") return;
  const busy = isBusy();
  if (busy && !guarding) window.addEventListener("beforeunload", beforeUnload);
  if (!busy && guarding) window.removeEventListener("beforeunload", beforeUnload);
  guarding = busy;
}
