"use client";

import { useEffect, useState } from "react";
import { endOfficeHeartbeat, officeHeartbeat, openOfficeSession } from "@/lib/data/api";
import { isApiError } from "@/lib/data/http";
import type { FileEditor, OfficeSession } from "@/lib/data/types";
import { onFileEvent } from "@/lib/fileEvents";
import { officeTheme } from "./officeTheme";

/** How often an editing page says it is still there (the API forgets it after 60 s). */
const HEARTBEAT_MS = 30_000;

export type OfficeSessionState =
  | { status: "loading"; editors: FileEditor[] }
  | { status: "ready"; session: OfficeSession; editors: FileEditor[] }
  | { status: "error"; reason: "unavailable" | "unsupported" | "forbidden"; editors: FileEditor[] };

/**
 * Open `fileId` in the editor, keep the API told that this page is editing it, and follow who else
 * is. Says goodbye when the editor closes and when the page goes away.
 */
export function useOfficeSession(fileId: string, convert: boolean): OfficeSessionState {
  const [state, setState] = useState<OfficeSessionState>({ status: "loading", editors: [] });

  useEffect(() => {
    let cancelled = false;
    openOfficeSession(fileId, { theme: officeTheme(), mode: convert ? "convert" : undefined })
      .then((session) => {
        if (!cancelled) setState({ status: "ready", session, editors: session.file.editors ?? [] });
      })
      .catch((err) => {
        if (cancelled) return;
        const reason = isApiError(err, 403) ? "forbidden" : isApiError(err, 400) ? "unsupported" : "unavailable";
        setState({ status: "error", reason, editors: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, convert]);

  const editing = state.status === "ready" && state.session.mode === "edit";

  useEffect(() => {
    if (!editing) return;
    const beat = () => {
      void officeHeartbeat(fileId).catch(() => {});
    };
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    const bye = () => endOfficeHeartbeat(fileId);
    window.addEventListener("pagehide", bye);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", bye);
      bye();
    };
  }, [editing, fileId]);

  useEffect(
    () =>
      onFileEvent((event) => {
        if (event.type === "editing" && event.fileId === fileId) {
          setState((prev) => ({ ...prev, editors: event.editors }));
        }
      }),
    [fileId],
  );

  return state;
}
