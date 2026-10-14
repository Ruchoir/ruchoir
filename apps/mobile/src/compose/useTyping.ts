/**
 * "Léa is writing…": who else is writing in a conversation, and my own signal while I write.
 *
 * Someone shows as writing for five seconds after their last signal, or until their message arrives;
 * mine goes at most every three seconds, which is often enough for theirs to stay up.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useRealtimeActions, useRealtimeEvent } from "../realtime/RealtimeProvider";

const SHOWN_MS = 5000;
const SIGNAL_EVERY_MS = 3000;

/** The user ids writing in `conversationId` right now, me aside. */
export function useTypingUsers(conversationId: string, myUserId: string | undefined): string[] {
  const [until, setUntil] = useState<Record<string, number>>({});

  useRealtimeEvent((event) => {
    if (event.type === "typing" && event.conversationId === conversationId && event.userId !== myUserId) {
      setUntil((prev) => ({ ...prev, [event.userId]: Date.now() + SHOWN_MS }));
    } else if (
      event.type === "message" &&
      event.conversationId === conversationId &&
      event.change === "created" &&
      event.message.authorId
    ) {
      const author = event.message.authorId;
      setUntil((prev) => {
        if (!(author in prev)) return prev;
        const next = { ...prev };
        delete next[author];
        return next;
      });
    }
  });

  // Clear whoever has gone quiet, at the moment the first of them does.
  useEffect(() => {
    const ends = Object.values(until);
    if (ends.length === 0) return;
    const timer = setTimeout(
      () => {
        const now = Date.now();
        setUntil((prev) => Object.fromEntries(Object.entries(prev).filter(([, end]) => end > now)));
      },
      Math.max(0, Math.min(...ends) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [until]);

  return Object.keys(until);
}

/** A function to call on every keystroke; it sends the signal when it is due. */
export function useTypingSignal(conversationId: string): () => void {
  const { sendTyping } = useRealtimeActions();
  const last = useRef(0);
  useEffect(() => {
    last.current = 0;
  }, [conversationId]);
  return useCallback(() => {
    const now = Date.now();
    if (now - last.current < SIGNAL_EVERY_MS) return;
    last.current = now;
    sendTyping(conversationId);
  }, [conversationId, sendTyping]);
}
