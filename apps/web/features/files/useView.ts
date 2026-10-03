"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpaceFile } from "@/lib/data";
import { type FilesView, getFilesView, searchFiles, type ViewEntry } from "@/lib/data/api";

/** How long typing rests before the space is searched. */
const SEARCH_DELAY_MS = 250;

/**
 * A view beyond a folder, kept loaded: recent, favourites, shared with me, or a search through the
 * whole space when there are words to look for (a search wins over the view it was typed in).
 * `null` entries while it loads, or when nothing is asked (the folder is on screen).
 */
export function useView(spaceId: string, view: FilesView | null, query: string, onError: () => void) {
  const [entries, setEntries] = useState<ViewEntry[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });
  const words = query.trim();

  useEffect(() => {
    if (!view && !words) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing asked: nothing held
      setEntries(null);
      return;
    }
    const ctrl = new AbortController();
    const run = () =>
      (words ? searchFiles(spaceId, words, ctrl.signal) : getFilesView(spaceId, view as FilesView, ctrl.signal))
        .then(setEntries)
        .catch(() => {
          if (ctrl.signal.aborted) return;
          setEntries([]);
          onErrorRef.current();
        });
    // A search waits for the typing to rest; a view loads at once.
    const timer = window.setTimeout(run, words ? SEARCH_DELAY_MS : 0);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [spaceId, view, words, reloadKey]);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);
  /** Change one entry in place (a favourite marked) without asking again. */
  const patch = useCallback((id: string, change: Partial<SpaceFile>) => {
    setEntries((prev) => prev?.map((e) => (e.file.id === id ? { ...e, file: { ...e.file, ...change } } : e)) ?? prev);
  }, []);

  return { entries, reload, patch };
}
