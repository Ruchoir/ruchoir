/**
 * Load something from the API for a screen, the way the web's screens do: an `AbortController`
 * per request, a reload on demand, and a refetch whenever the realtime connection asks for one.
 *
 * `key` names what is loaded (`"channels:<space id>"`): when it changes, the previous result is not
 * shown for the new key, so switching space never paints the last space's rows.
 */
import { isApiError } from "@ruchoir/client";
import { useCallback, useEffect, useRef, useState } from "react";

import { useResync } from "../realtime/RealtimeProvider";

export type Loaded<T> = {
  data: T | undefined;
  /** Set when the last attempt failed; `offline` when the instance could not be reached at all. */
  error: { offline: boolean } | null;
  loading: boolean;
  reload: () => void;
};

export function useLoad<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Loaded<T> {
  const resync = useResync();
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: T; error?: { offline: boolean } }>({ key: "" });
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    latest.current(controller.signal).then(
      (data) => setResult({ key, data }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        // A 401 is the session's business (it signs out); anything else is this screen's.
        setResult((prev) => ({
          key,
          data: prev.key === key ? prev.data : undefined,
          error: { offline: !isApiError(err) },
        }));
      },
    );
    return () => controller.abort();
  }, [key, tick, resync]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const mine = result.key === key;
  return {
    data: mine ? result.data : undefined,
    error: mine ? (result.error ?? null) : null,
    loading: key !== null && (!mine || (result.data === undefined && !result.error)),
    reload,
  };
}
