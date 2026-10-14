/**
 * Files of the phone on their way to a space, above the screens (as the composer's outbox is), so
 * leaving a folder does not stop them. One goes at a time, with its progress; the list then reloads
 * through the live `files` event. The queue itself is `logic/uploadQueue.ts`.
 */
import { isApiError, startFileUpload, startFileVersionUpload } from "@ruchoir/client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { LocalFile } from "../compose/useAttachments";
import { useTranslation } from "../i18n";
import {
  answer as answerQueue,
  enqueue,
  enqueueVersion,
  markDone,
  markFailed,
  markSending,
  markSent,
  nextToSend,
  progressDue,
  remove as removeItem,
  retry as retryItem,
  type Choice,
  type Existing,
  type QueueItem,
  type UploadTarget,
} from "../logic/uploadQueue";
import { feel } from "../ui/haptics";
import { useToast } from "../ui/Toast";

type UploadsApi = {
  queue: QueueItem[];
  /** Picked files into the queue for `target`, against the folder's entries; true when a name asks. */
  add: (picked: LocalFile[], target: UploadTarget, existing: Existing[], label: string) => boolean;
  /** A file of the phone as a new version of `of`. */
  addVersion: (file: LocalFile, target: UploadTarget, of: { id: string; name: string }) => void;
  answer: (key: string, choice: Choice, forAll: boolean) => void;
  retry: (key: string) => void;
  remove: (key: string) => void;
  /** What the folder of an item is called ("Clients", or the space at its root). */
  label: (item: QueueItem) => string;
  /** The entries of the folder of an item, as they were when it was queued. */
  existing: (item: QueueItem) => Existing[];
};

const UploadsContext = createContext<UploadsApi | null>(null);

const folderKey = (t: UploadTarget) => `${t.spaceId}/${t.folderId ?? ""}`;

let keys = 0;
const nextKey = () => `upload-${++keys}`;

export function UploadsProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  // The queue as last committed, for callbacks that run after a render (progress, answers).
  const current = useRef<QueueItem[]>([]);
  const commit = useCallback((next: (q: QueueItem[]) => QueueItem[]) => {
    current.current = next(current.current);
    setQueue(current.current);
  }, []);
  const folders = useRef(new Map<string, { existing: Existing[]; label: string }>());
  const aborts = useRef(new Map<string, () => void>());
  // When each file's progress was last told: the screens hear it four times a second at most.
  const told = useRef(new Map<string, number>());

  // Signed out (this provider goes with the session): what is still going stops there.
  useEffect(() => {
    const running = aborts.current;
    return () => running.forEach((abort) => abort());
  }, []);

  // One at a time: the first waiting file goes once nothing else is going.
  useEffect(() => {
    const item = nextToSend(queue);
    if (!item) return;
    commit((q) => markSending(q, item.key));
    const part = { uri: item.file.uri, name: item.name, type: item.file.mime };
    const onProgress = (sent: number) => {
      const now = Date.now();
      if (!progressDue(told.current.get(item.key), now)) return;
      told.current.set(item.key, now);
      commit((q) => markSent(q, item.key, sent));
    };
    const request = item.replaceFileId
      ? startFileVersionUpload(item.replaceFileId, part, onProgress)
      : startFileUpload(item.spaceId, part, item.folderId, onProgress);
    aborts.current.set(item.key, request.abort);
    request.done
      .then(
        () => commit((q) => markDone(q, item.key)),
        (err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          const error = isApiError(err, 413) ? "tooLarge" : isApiError(err, 403) ? "forbidden" : "network";
          feel("failure");
          commit((q) => markFailed(q, item.key, error));
        },
      )
      .finally(() => {
        aborts.current.delete(item.key);
        told.current.delete(item.key);
      });
  }, [queue, commit]);

  // All gone: say so, and forget what is done (what failed stays, to be retried or removed).
  useEffect(() => {
    if (queue.some((i) => i.state === "asking" || i.state === "waiting" || i.state === "sending")) return;
    const done = queue.filter((i) => i.state === "done");
    if (done.length === 0) return;
    commit((q) => q.filter((i) => i.state !== "done"));
    toast(t("files.uploaded", { count: done.length }), "success");
  }, [queue, commit, t, toast]);

  const api = useMemo<UploadsApi>(
    () => ({
      queue,
      add: (picked, target, existing, label) => {
        folders.current.set(folderKey(target), { existing, label });
        commit((q) => enqueue(q, picked, target, existing, nextKey));
        return current.current.some((i) => i.state === "asking");
      },
      addVersion: (file, target, of) => commit((q) => enqueueVersion(q, file, target, of, nextKey)),
      answer: (key, choice, forAll) => {
        const item = current.current.find((i) => i.key === key);
        if (!item) return;
        // Each file against its own folder's entries, when the answer is for all of them.
        commit((q) => answerQueue(q, key, choice, forAll, (i) => folders.current.get(folderKey(i))?.existing ?? []));
      },
      retry: (key) => commit((q) => retryItem(q, key)),
      remove: (key) => {
        aborts.current.get(key)?.();
        commit((q) => removeItem(q, key));
      },
      label: (item) => folders.current.get(folderKey(item))?.label ?? "",
      existing: (item) => folders.current.get(folderKey(item))?.existing ?? [],
    }),
    [queue, commit],
  );
  return <UploadsContext.Provider value={api}>{children}</UploadsContext.Provider>;
}

export function useUploads(): UploadsApi {
  const api = useContext(UploadsContext);
  if (!api) throw new Error("useUploads outside UploadsProvider");
  return api;
}
