"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpaceFile } from "@/lib/data";
import { getFolder } from "@/lib/data/api";
import { onFileEvent } from "@/lib/fileEvents";

export type Crumb = { id: string; name: string };

/**
 * One folder of a space, kept current: its entries, its breadcrumb, and the live changes other
 * people make to it (a new version, a file the server created, who is editing what).
 *
 * `onError` is read through a ref, so a parent passing a fresh function on every render does not
 * rebuild the loader and refetch the folder (which looped a failing fetch and never let the network
 * go idle).
 */
export function useFolder(spaceId: string, onError: () => void) {
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

  useEffect(() => {
    // The space root on mount, and again when the space changes. Fetching on mount is the point.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(undefined);
  }, [load]);

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
        } else {
          setEntries((prev) => prev.map((f) => (f.id === event.fileId ? { ...f, editors: event.editors } : f)));
        }
      }),
    [spaceId],
  );

  return { entries, breadcrumb, folderId, loading, load, reload };
}
