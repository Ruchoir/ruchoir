/**
 * Files of the phone on their way to a space, as data: each one waits, goes, and is done or failed;
 * one the server refuses as a duplicate asks (`asking`) and goes again with the answer. The server
 * decides what a duplicate is, against the whole space (`UploadDuplicate`): the folder's list on the
 * phone may not hold every file, an old one out of a "Recent" view for one. One goes at a time; the
 * screens show the queue and the uploads provider sends what `nextToSend` gives.
 */
import type { DuplicateAnswer, UploadDuplicate } from "@ruchoir/client";

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
  /** What the server found already there, while the item asks. */
  duplicate?: UploadDuplicate;
  /** The person's answer to it, sent with the file the next time. */
  answer?: DuplicateAnswer;
};

/**
 * "Replace" (the file there gets a new version), "keep both" (a numbered name) or "skip". Which ones
 * are offered depends on the duplicate: the same file offers replacing it, the same name with other
 * contents offers another name (decided with Lilou, 2026-10-19).
 */
export type Choice = "replace" | "keepBoth" | "skip";

/** What a duplicate of each reason offers, besides skipping it. */
export function choicesFor(reason: UploadDuplicate["reason"]): Choice[] {
  return reason === "same_file" ? ["replace", "skip"] : reason === "same_name" ? ["keepBoth", "skip"] : ["skip"];
}

/** Picked files into the queue for `target`, each waiting its turn. */
export function enqueue(queue: QueueItem[], picked: LocalFile[], target: UploadTarget, nextKey: () => string): QueueItem[] {
  return [...queue, ...picked.map((file): QueueItem => ({ key: nextKey(), file, ...target, name: file.name, state: "waiting", sent: 0 }))];
}

/** A file of the phone as a new version of the entry `of`, under that entry's name. */
export function enqueueVersion(queue: QueueItem[], file: LocalFile, target: UploadTarget, of: { id: string; name: string }, nextKey: () => string): QueueItem[] {
  return [...queue, { key: nextKey(), file, ...target, name: of.name, state: "waiting", sent: 0, replaceFileId: of.id }];
}

/** The server refused `key` as a duplicate: it asks. */
export function markDuplicate(queue: QueueItem[], key: string, duplicate: UploadDuplicate): QueueItem[] {
  return change(queue, key, { state: "asking", duplicate, sent: 0 });
}

/** The first file waiting for an answer about a duplicate. */
export function nextQuestion(queue: QueueItem[]): QueueItem | undefined {
  return queue.find((i) => i.state === "asking");
}

/**
 * The answer about `key`, and with `forAll` about every other one asking for the same reason. A
 * choice the duplicate does not offer skips it.
 */
export function answer(queue: QueueItem[], key: string, choice: Choice, forAll: boolean): QueueItem[] {
  const asked = queue.find((i) => i.key === key);
  if (!asked?.duplicate) return queue;
  const reason = asked.duplicate.reason;
  const answered = (i: QueueItem) =>
    i.state === "asking" && (i.key === key || (forAll && i.duplicate?.reason === reason));
  return queue.flatMap((i): QueueItem[] => {
    if (!answered(i)) return [i];
    if (choice === "skip" || !choicesFor(i.duplicate!.reason).includes(choice)) return [];
    return [{ ...i, state: "waiting", duplicate: undefined, answer: choice === "replace" ? "replace" : "keep_both" }];
  });
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

/** Whether a file's progress is worth telling the screens again: four times a second at most. */
export function progressDue(lastAt: number | undefined, now: number, interval = 250): boolean {
  return lastAt === undefined || now - lastAt >= interval;
}
