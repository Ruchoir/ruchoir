"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { endOfficeHeartbeat, getConvertedCopy, officeHeartbeat, openOfficeSession } from "@/lib/data/api";
import { isApiError } from "@/lib/data/http";
import type { FileEditor, OfficeSession, SpaceFile } from "@/lib/data/types";
import { onFileEvent } from "@/lib/fileEvents";
import { officeTheme, touchScreen } from "./officeTheme";

/** How often an editing tab says it is still there (the API forgets it after 60 s). */
const HEARTBEAT_MS = 30_000;
/** How often a converting tab asks whether the engine has written the copy yet. */
const COPY_POLL_MS = 3_000;
/** How long a conversion may take before the tab says it did not come through. */
const COPY_WAIT_MS = 120_000;

/** Why the editor could not open, each with its own sentence. */
export type OfficeFailure =
  | "unavailable"
  | "unsupported"
  | "forbidden"
  | "missing"
  | "signedOut"
  | "conversion"
  | "failed";

export type OfficeSessionState =
  | { status: "loading"; editors: FileEditor[] }
  | {
      status: "ready";
      session: OfficeSession;
      editors: FileEditor[];
      /** A conversion's copy, once the engine has written it: the editor carries on there. */
      copy?: SpaceFile;
    }
  | { status: "error"; reason: OfficeFailure; editors: FileEditor[] };

/** The failure an API error means. Only the engine being down falls back to the preview. */
function failureOf(err: unknown): OfficeFailure {
  if (isApiError(err, 503)) return "unavailable";
  if (isApiError(err, 403)) return "forbidden";
  if (isApiError(err, 400)) return "unsupported";
  if (isApiError(err, 404)) return "missing";
  if (isApiError(err, 401)) return "signedOut";
  return "failed";
}

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
): { state: OfficeSessionState; leave: () => Promise<void>; noteChange: () => void } {
  const [state, setState] = useState<OfficeSessionState>({ status: "loading", editors: [] });
  const [tab] = useState(newTabId);

  useEffect(() => {
    let cancelled = false;
    openOfficeSession(fileId, { theme: officeTheme(), mode: convert ? "convert" : undefined, mobile: touchScreen() })
      .then((session) => {
        if (!cancelled) setState({ status: "ready", session, editors: session.file.editors ?? [] });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: "error", reason: failureOf(err), editors: [] });
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
  // the bare editor, out of Ruchoir.
  useEffect(() => {
    if (!awaitingCopy) return;
    let cancelled = false;
    let opening = false;
    const started = Date.now();
    const look = () => {
      if (opening) return;
      if (Date.now() - started > COPY_WAIT_MS) {
        // The engine never wrote the copy: say so rather than waiting for the life of the tab.
        window.clearInterval(timer);
        setState({ status: "error", reason: "conversion", editors: [] });
        return;
      }
      getConvertedCopy(fileId)
        .then(async (found) => {
          if (cancelled || !found?.id) return;
          opening = true;
          const next = await openOfficeSession(found.id, { theme: officeTheme(), mobile: touchScreen() });
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

  // Opening a document is not editing it: the tab counts as editing (heartbeat, badge, band) from the
  // first change the editor reports (`Edit_Notification`, which the editor's frame posts when the
  // document changes; WOPI's `EditNotificationPostMessage`), so a member who only reads is not shown.
  // The frame's messages are received by the editor screen, which knows the frame (`noteChange`).
  const [changedId, setChangedId] = useState<string | null>(null);
  const editableRef = useRef<string | null>(null);
  useEffect(() => {
    editableRef.current = editableId;
  });
  const noteChange = useCallback(() => {
    if (editableRef.current) setChangedId(editableRef.current);
  }, []);

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

  return { state, leave, noteChange };
}
