/**
 * What a sheet asks of the conversation beneath it. The message sheet is a screen of its own, so it
 * cannot reach the conversation's composer: it asks here, and the conversation, still mounted under
 * the sheet, answers.
 */
import { useEffect, useRef } from "react";

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
