/**
 * Files of the phone on their way to a space, as data: each one waits, asks when its name is taken in
 * its folder (the web's "replace, keep both or skip"), goes, and is done or failed. One goes at a
 * time; the screens show the queue and the uploads provider sends what `nextToSend` gives.
 */
import { isTaken, uniqueName } from "@ruchoir/client/filesLogic";

import type { LocalFile } from "../compose/useAttachments.ts";

export type UploadTarget = { spaceId: string; folderId?: string };

export type QueueItem = {
  key: string;
  file: LocalFile;
  spaceId: string;
  folderId?: string;
  /** The name it is stored under. */
  name: string;
  state: "asking" | "waiting" | "sending" | "done" | "failed";
  sent: number;
  /** A new version of this file rather than a new file. */
  replaceFileId?: string;
  error?: "tooLarge" | "forbidden" | "network";
};

/** An entry already in the target folder, and whether the person may replace it. */
export type Existing = { id: string; name: string; manage: boolean };

export type Choice = "replace" | "keepBoth" | "skip";

const sameFolder = (a: UploadTarget, b: UploadTarget) => a.spaceId === b.spaceId && (a.folderId ?? "") === (b.folderId ?? "");

/** The names taken in `target` for `self`: what is there, and what else is on its way there. */
function takenFor(queue: QueueItem[], target: UploadTarget, existing: Existing[], self?: string): string[] {
  return [...existing.map((e) => e.name), ...queue.filter((i) => i.key !== self && sameFolder(i, target)).map((i) => i.name)];
}

/** Picked files into the queue for `target`: a free name waits its turn, a taken one asks first. */
export function enqueue(queue: QueueItem[], picked: LocalFile[], target: UploadTarget, existing: Existing[], nextKey: () => string): QueueItem[] {
  let out = queue;
  for (const file of picked) {
    const taken = isTaken(file.name, takenFor(out, target, existing));
    out = [...out, { key: nextKey(), file, ...target, name: file.name, state: taken ? "asking" : "waiting", sent: 0 }];
  }
  return out;
}

/** A file of the phone as a new version of the entry `of`, under that entry's name. */
export function enqueueVersion(queue: QueueItem[], file: LocalFile, target: UploadTarget, of: { id: string; name: string }, nextKey: () => string): QueueItem[] {
  return [...queue, { key: nextKey(), file, ...target, name: of.name, state: "waiting", sent: 0, replaceFileId: of.id }];
}

/** The first file waiting for an answer about its name. */
export function nextQuestion(queue: QueueItem[]): QueueItem | undefined {
  return queue.find((i) => i.state === "asking");
}

/**
 * The answer about `key`'s name, and with `forAll` about every other one asking. "Replace" makes a
 * new version of the entry of that name when the person may manage it, else it keeps both.
 */
export function answer(queue: QueueItem[], key: string, choice: Choice, forAll: boolean, existing: Existing[]): QueueItem[] {
  const answered = new Set(forAll ? queue.filter((i) => i.state === "asking").map((i) => i.key) : [key]);
  let out = queue;
  for (const item of queue) {
    if (!answered.has(item.key) || item.state !== "asking") continue;
    if (choice === "skip") {
      out = out.filter((i) => i.key !== item.key);
      continue;
    }
    const same = choice === "replace" ? existing.find((e) => isTaken(item.file.name, [e.name])) : undefined;
    const next: Partial<QueueItem> =
      same?.manage
        ? { name: same.name, replaceFileId: same.id, state: "waiting" }
        : { name: uniqueName(item.file.name, takenFor(out, item, existing, item.key)), state: "waiting" };
    out = out.map((i) => (i.key === item.key ? { ...i, ...next } : i));
  }
  return out;
}

/** What goes next: the first waiting file, once nothing else is going. */
export function nextToSend(queue: QueueItem[]): QueueItem | undefined {
  return queue.some((i) => i.state === "sending") ? undefined : queue.find((i) => i.state === "waiting");
}

const change = (queue: QueueItem[], key: string, patch: Partial<QueueItem>) => queue.map((i) => (i.key === key ? { ...i, ...patch } : i));

export function markSending(queue: QueueItem[], key: string): QueueItem[] {
  return change(queue, key, { state: "sending", sent: 0, error: undefined });
}

export function markSent(queue: QueueItem[], key: string, sent: number): QueueItem[] {
  return change(queue, key, { sent });
}

export function markDone(queue: QueueItem[], key: string): QueueItem[] {
  return queue.map((i) => (i.key === key ? { ...i, state: "done", sent: i.file.size ?? i.sent } : i));
}

export function markFailed(queue: QueueItem[], key: string, error: NonNullable<QueueItem["error"]>): QueueItem[] {
  return change(queue, key, { state: "failed", error });
}

/** A failed file back in line; anything else stays as it is, so nothing goes twice. */
export function retry(queue: QueueItem[], key: string): QueueItem[] {
  return queue.some((i) => i.key === key && i.state === "failed") ? change(queue, key, { state: "waiting", sent: 0, error: undefined }) : queue;
}

export function remove(queue: QueueItem[], key: string): QueueItem[] {
  return queue.filter((i) => i.key !== key);
}

/** For the strip: what is not done yet, the bytes of what waits or goes, and what failed. */
export function progress(queue: QueueItem[]): { count: number; sent: number; total: number; failed: number } {
  const going = queue.filter((i) => i.state === "waiting" || i.state === "sending");
  return {
    count: queue.filter((i) => i.state !== "done").length,
    sent: going.reduce((n, i) => n + i.sent, 0),
    total: going.reduce((n, i) => n + (i.file.size ?? 0), 0),
    failed: queue.filter((i) => i.state === "failed").length,
  };
}
