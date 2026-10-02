"use client";

import { useEffect, useState } from "react";
import { endOfficeHeartbeat, getConvertedCopy, officeHeartbeat, openOfficeSession } from "@/lib/data/api";
import { isApiError } from "@/lib/data/http";
import type { FileEditor, OfficeSession, SpaceFile } from "@/lib/data/types";
import { onFileEvent } from "@/lib/fileEvents";
import { officeTheme } from "./officeTheme";

/** How often an editing tab says it is still there (the API forgets it after 60 s). */
const HEARTBEAT_MS = 30_000;
/** How often a converting tab asks whether the engine has written the copy yet. */
const COPY_POLL_MS = 3_000;

export type OfficeSessionState =
  | { status: "loading"; editors: FileEditor[] }
  | {
      status: "ready";
      session: OfficeSession;
      editors: FileEditor[];
      /** A conversion's copy, once the engine has written it: the editor carries on there. */
      copy?: SpaceFile;
    }
  | { status: "error"; reason: "unavailable" | "unsupported" | "forbidden"; editors: FileEditor[] };

/** An id this tab keeps for its life, so the API tells two tabs of one member apart. */
function newTabId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Open `fileId` in the editor, keep the API told that this tab is editing it, and follow who else
 * is. In a conversion, find the copy the engine writes and report editing that instead. Says goodbye
 * when the editor closes and when the page goes away.
 */
export function useOfficeSession(fileId: string, convert: boolean): OfficeSessionState {
  const [state, setState] = useState<OfficeSessionState>({ status: "loading", editors: [] });
  const [tab] = useState(newTabId);

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

  const mode = state.status === "ready" ? state.session.mode : null;
  const copy = state.status === "ready" ? state.copy : undefined;
  const awaitingCopy = mode === "convert" && !copy;

  // A conversion: ask until the engine has written the copy.
  useEffect(() => {
    if (!awaitingCopy) return;
    let cancelled = false;
    const look = () => {
      getConvertedCopy(fileId)
        .then((found) => {
          if (cancelled || !found) return;
          setState((prev) => (prev.status === "ready" ? { ...prev, copy: found, editors: found.editors ?? [] } : prev));
        })
        .catch(() => {});
    };
    const timer = window.setInterval(look, COPY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [awaitingCopy, fileId]);

  /** The file this tab is editing: the original in an edit session, a conversion's copy once known. */
  const editedId = mode === "edit" ? fileId : (copy?.id ?? null);

  useEffect(() => {
    if (!editedId) return;
    const beat = () => {
      void officeHeartbeat(editedId, tab).catch(() => {});
    };
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    const bye = () => endOfficeHeartbeat(editedId, tab);
    window.addEventListener("pagehide", bye);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", bye);
      bye();
    };
  }, [editedId, tab]);

  useEffect(
    () =>
      onFileEvent((event) => {
        if (event.type === "editing" && event.fileId === editedId) {
          setState((prev) => ({ ...prev, editors: event.editors }));
        }
      }),
    [editedId],
  );

  return state;
}
