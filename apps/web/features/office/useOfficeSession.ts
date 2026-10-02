"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
export function useOfficeSession(
  fileId: string,
  convert: boolean,
): { state: OfficeSessionState; leave: () => Promise<void> } {
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

  // A conversion: ask until the engine has written the copy, then open the copy for editing in the
  // same frame. The engine's own page would instead offer a button that navigates the whole tab to
  // the bare editor, out of Ruchoir (and the frame's sandbox refuses that anyway).
  useEffect(() => {
    if (!awaitingCopy) return;
    let cancelled = false;
    let opening = false;
    const look = () => {
      if (opening) return;
      getConvertedCopy(fileId)
        .then(async (found) => {
          if (cancelled || !found?.id) return;
          opening = true;
          const next = await openOfficeSession(found.id, { theme: officeTheme() });
          if (!cancelled) setState({ status: "ready", session: next, copy: found, editors: next.file.editors ?? [] });
        })
        .catch(() => {
          opening = false;
        });
    };
    const timer = window.setInterval(look, COPY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [awaitingCopy, fileId]);

  /** The file this tab may edit: the session's own file, once it is an edit session. */
  const editableId = state.status === "ready" && state.session.mode === "edit" ? (state.session.file.id ?? null) : null;
  const engineOrigin = state.status === "ready" ? new URL(state.session.url).origin : null;

  // Opening a document is not editing it: the tab counts as editing (heartbeat, badge, band) from the
  // first change the editor reports (`Edit_Notification`, posted by the engine's page when the
  // document changes; WOPI's `EditNotificationPostMessage`), so a member who only reads is not shown.
  const [changedId, setChangedId] = useState<string | null>(null);
  useEffect(() => {
    if (!engineOrigin || !editableId) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== engineOrigin || typeof e.data !== "string") return;
      try {
        if ((JSON.parse(e.data) as { MessageId?: string }).MessageId === "Edit_Notification") setChangedId(editableId);
      } catch {
        // Not a WOPI message.
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [engineOrigin, editableId]);

  /** The file this tab is editing: the editable file, once it has changed here. */
  const editedId = editableId && changedId === editableId ? editableId : null;
  const editedRef = useRef<string | null>(null);
  /** Set once this tab said goodbye itself, so tearing down does not say it twice. */
  const leftRef = useRef(false);

  useEffect(() => {
    editedRef.current = editedId;
    if (!editedId) return;
    leftRef.current = false;
    const beat = () => {
      if (!leftRef.current) void officeHeartbeat(editedId, tab).catch(() => {});
    };
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    const bye = () => {
      if (!leftRef.current) void endOfficeHeartbeat(editedId, tab);
    };
    window.addEventListener("pagehide", bye);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", bye);
      bye();
    };
  }, [editedId, tab]);

  /**
   * Say goodbye and wait until the API has it. Closing the editor goes through here before the file
   * list reloads: a reload that overtook the goodbye would show this tab still editing, and nothing
   * would correct it afterwards.
   */
  const leave = useCallback(async () => {
    const edited = editedRef.current;
    if (!edited || leftRef.current) return;
    leftRef.current = true;
    await endOfficeHeartbeat(edited, tab);
  }, [tab]);

  useEffect(
    () =>
      onFileEvent((event) => {
        if (event.type === "editing" && event.fileId === (editableId ?? fileId)) {
          setState((prev) => ({ ...prev, editors: event.editors }));
        }
      }),
    [editableId, fileId],
  );

  return { state, leave };
}
