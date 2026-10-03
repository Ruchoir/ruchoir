"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpaceFile } from "@/lib/data";
import { getFolder } from "@/lib/data/api";
import { onFileEvent } from "@/lib/fileEvents";
import { onUploadDone } from "@/lib/uploads";

export type Crumb = { id: string; name: string };

/**
 * One folder of a space, kept current: its entries, its breadcrumb, and the live changes other
 * people make to it (a new version, a file the server created, who is editing what).
 *
 * `onError` is read through a ref, so a parent passing a fresh function on every render does not
 * rebuild the loader and refetch the folder (which looped a failing fetch and never let the network
 * go idle).
 */
export function useFolder(spaceId: string, onError: () => void, initialFolderId?: string) {
  const [entries, setEntries] = useState<SpaceFile[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<Crumb[]>([]);
  const [folderId, setFolderId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  // A slow answer for a folder already left must not overwrite the one now open.
  const requestRef = useRef(0);

  /** Load a folder (the space root when `id` is undefined). */
  const load = useCallback(
    (id?: string) => {
      const request = ++requestRef.current;
      setLoading(true);
      getFolder(spaceId, id)
        .then((listing) => {
          if (request !== requestRef.current) return;
          setEntries(listing.entries);
          setBreadcrumb(listing.breadcrumb);
          setFolderId(listing.folderId);
          setLoading(false);
        })
        .catch(() => {
          if (request !== requestRef.current) return;
          setEntries([]);
          setLoading(false);
          onErrorRef.current();
        });
    },
    [spaceId],
  );

  // Where to start, for the space it was given with. Not cleared on use: a development build runs
  // an effect twice, and the second run must land on the same folder. A change of space forgets it.
  const initialRef = useRef<{ space: string; folder?: string } | null>({ space: spaceId, folder: initialFolderId });
  useEffect(() => {
    // The first folder on mount (the space root unless one was asked for), and the root again when
    // the space changes. Fetching on mount is the point.
    if (initialRef.current && initialRef.current.space !== spaceId) initialRef.current = null;
    load(initialRef.current?.folder);
  }, [load, spaceId]);

  const folderRef = useRef(folderId);
  useEffect(() => {
    folderRef.current = folderId;
  });
  const reload = useCallback(() => load(folderRef.current), [load]);

  useEffect(
    () =>
      onFileEvent((event) => {
        if (event.spaceId !== spaceId) return;
        if (event.type === "updated") {
          setEntries((prev) => {
            if (prev.some((f) => f.id === event.file.id)) {
              return prev.map((f) => (f.id === event.file.id ? { ...event.file, editors: f.editors } : f));
            }
            // A private conversation's file is in no folder: it never joins a listing.
            const here = !event.conversationId && event.file.parentFolderId === folderRef.current;
            return here ? [...prev, event.file] : prev;
          });
        } else if (event.type === "deleted") {
          const gone = new Set(event.fileIds);
          setEntries((prev) => prev.filter((f) => !f.id || !gone.has(f.id)));
        } else {
          setEntries((prev) => prev.map((f) => (f.id === event.fileId ? { ...f, editors: event.editors } : f)));
        }
      }),
    [spaceId],
  );

  /** One more entry in a folder this list shows, so its size does not read "empty" while it fills. */
  const bumpCount = (folderId: string | undefined) => {
    if (!folderId) return;
    setEntries((prev) => prev.map((f) => (f.id === folderId && f.kind === "folder" ? { ...f, childCount: (f.childCount ?? 0) + 1 } : f)));
  };

  // What this person sends lands here as each file arrives, without waiting for the server's word
  // about it (which goes to the others) or for a reload that would lose the place in the list.
  useEffect(
    () =>
      onUploadDone((job, file) => {
        if (job.spaceId !== spaceId) return;
        if (file.parentFolderId !== folderRef.current) {
          // Into a folder of this list: one more entry in it.
          if (!job.replaceFileId) bumpCount(file.parentFolderId);
          return;
        }
        setEntries((prev) => (prev.some((f) => f.id === file.id) ? prev.map((f) => (f.id === file.id ? { ...file, editors: f.editors } : f)) : [...prev, file]));
      }),
    [spaceId],
  );

  /** Put an entry made here (a folder created for an upload, a version brought back) in the list if it belongs to it. */
  const upsert = useCallback((file: SpaceFile) => {
    if (file.parentFolderId !== folderRef.current) {
      bumpCount(file.parentFolderId);
      return;
    }
    // A newer copy of an entry already listed (a version brought back) replaces it.
    setEntries((prev) => (prev.some((f) => f.id === file.id) ? prev.map((f) => (f.id === file.id ? { ...file, editors: f.editors } : f)) : [...prev, file]));
  }, []);

  return { entries, breadcrumb, folderId, loading, load, reload, upsert };
}
