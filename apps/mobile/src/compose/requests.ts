/**
 * What a sheet asks of the conversation beneath it. The message sheet is a screen of its own, so it
 * cannot reach the conversation's composer: it asks here, and the conversation, still mounted under
 * the sheet, answers.
 */
import type { SpaceFile } from "@ruchoir/client";
import { useEffect, useRef } from "react";

import type { LocalFile } from "./useAttachments";

export type EditRequest = { conversationId: string; id: string; body: string };

const listeners = new Set<(request: EditRequest) => void>();

/** Put a message's text in its conversation's composer, to be edited. */
export function requestEdit(request: EditRequest): void {
  listeners.forEach((listen) => listen(request));
}

/** Hear the edit requests for one conversation. */
export function useEditRequests(conversationId: string, onEdit: (request: EditRequest) => void): void {
  const latest = useRef(onEdit);
  useEffect(() => {
    latest.current = onEdit;
  });
  useEffect(() => {
    const listen = (request: EditRequest) => {
      if (request.conversationId === conversationId) latest.current(request);
    };
    listeners.add(listen);
    return () => {
      listeners.delete(listen);
    };
  }, [conversationId]);
}

/** What the attach sheet hands to a composer: files of the phone, or a file of the space. */
export type AttachRequest =
  | { draftKey: string; kind: "local"; files: LocalFile[] }
  | { draftKey: string; kind: "space"; file: SpaceFile };

const attachListeners = new Set<(request: AttachRequest) => void>();

/** Add files to the message being written under `draftKey`. */
export function requestAttach(request: AttachRequest): void {
  attachListeners.forEach((listen) => listen(request));
}

/** Hear the files picked for one composer. */
export function useAttachRequests(draftKey: string, onAttach: (request: AttachRequest) => void): void {
  const latest = useRef(onAttach);
  useEffect(() => {
    latest.current = onAttach;
  });
  useEffect(() => {
    const listen = (request: AttachRequest) => {
      if (request.draftKey === draftKey) latest.current(request);
    };
    attachListeners.add(listen);
    return () => {
      attachListeners.delete(listen);
    };
  }, [draftKey]);
}
