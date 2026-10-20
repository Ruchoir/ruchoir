/**
 * Files of the phone on their way to a space, above the screens (as the composer's outbox is), so
 * leaving a folder does not stop them. One goes at a time, with its progress; the list then reloads
 * through the live `files` event. The queue itself is `logic/uploadQueue.ts`.
 */
import { isApiError } from "@ruchoir/client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useApi } from "../api/useApi";
import type { LocalFile } from "../compose/useAttachments";
import { useTranslation } from "../i18n";
import {
  answer as answerQueue,
  enqueue,
  enqueueVersion,
  markDone,
  markDuplicate,
  markFailed,
  markSending,
  markSent,
  nextToSend,
  progressDue,
  remove as removeItem,
  retry as retryItem,
  type Choice,
  type QueueItem,
  type UploadTarget,
} from "../logic/uploadQueue";
import { feel } from "../ui/haptics";
import { useToast } from "../ui/Toast";

type UploadsApi = {
  queue: QueueItem[];
  /** Picked files into the queue for `target` (its folder called `label`). */
  add: (picked: LocalFile[], target: UploadTarget, label: string) => void;
  /** A file of the phone as a new version of `of`. */
  addVersion: (file: LocalFile, target: UploadTarget, of: { id: string; name: string }) => void;
  answer: (key: string, choice: Choice, forAll: boolean) => void;
  retry: (key: string) => void;
  remove: (key: string) => void;
  /** What the folder of an item is called ("Clients", or the space at its root). */
  label: (item: QueueItem) => string;
};

const UploadsContext = createContext<UploadsApi | null>(null);

const folderKey = (t: UploadTarget) => `${t.spaceId}/${t.folderId ?? ""}`;

let keys = 0;
const nextKey = () => `upload-${++keys}`;

export function UploadsProvider({ children }: { children: ReactNode }) {
  const { startFileUpload, startFileVersionUpload, uploadDuplicate } = useApi();
  const { t } = useTranslation();
  const toast = useToast();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  // The queue as last committed, for callbacks that run after a render (progress, answers).
  const current = useRef<QueueItem[]>([]);
  const commit = useCallback((next: (q: QueueItem[]) => QueueItem[]) => {
    current.current = next(current.current);
    setQueue(current.current);
  }, []);
  const folders = useRef(new Map<string, string>());
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
      : startFileUpload(item.spaceId, part, item.folderId, onProgress, item.answer);
    aborts.current.set(item.key, request.abort);
    request.done
      .then(
        (stored) => {
          // The same bytes were already in the space: that file has a new version, nothing new appeared.
          if (stored && "merged" in stored && stored.merged) toast(t("files.mergedVersion", { name: stored.name }));
          commit((q) => markDone(q, item.key));
        },
        (err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          const duplicate = uploadDuplicate(err);
          if (duplicate?.reason === "same_content") {
            // Already in the space, in a file this person may not change: where it is, and nothing sent.
            const where = [...duplicate.path, duplicate.existing.name].join(" / ");
            toast(t("files.alreadyThere", { where }));
            commit((q) => removeItem(q, item.key));
            return;
          }
          if (duplicate) {
            feel("warning");
            commit((q) => markDuplicate(q, item.key, duplicate));
            return;
          }
          const error = isApiError(err, 413) ? "tooLarge" : isApiError(err, 403) ? "forbidden" : "network";
          feel("failure");
          commit((q) => markFailed(q, item.key, error));
        },
      )
      .finally(() => {
        aborts.current.delete(item.key);
        told.current.delete(item.key);
      });
  }, [queue, commit, t, toast, startFileVersionUpload, startFileUpload, uploadDuplicate]);

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
      add: (picked, target, label) => {
        folders.current.set(folderKey(target), label);
        commit((q) => enqueue(q, picked, target, nextKey));
      },
      addVersion: (file, target, of) => commit((q) => enqueueVersion(q, file, target, of, nextKey)),
      answer: (key, choice, forAll) => commit((q) => answerQueue(q, key, choice, forAll)),
      retry: (key) => commit((q) => retryItem(q, key)),
      remove: (key) => {
        aborts.current.get(key)?.();
        commit((q) => removeItem(q, key));
      },
      label: (item) => folders.current.get(folderKey(item)) ?? "",
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
