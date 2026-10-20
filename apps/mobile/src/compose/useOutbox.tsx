/**
 * The messages on their way and the drafts, for the whole signed-in session.
 *
 * Above the screens, so leaving a conversation neither loses what was being written nor a message
 * still going out. A message is drawn at once from the outbox, sent, and handed to every screen as a
 * live event once the server has it; a failure stays on screen, marked, until it is retried or
 * dropped. The rules are in `logic/outbox.ts`.
 */
import type { InlineImage, MessageAttachment } from "@ruchoir/client";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";

import { useApi } from "../api/useApi";
import { outboxReducer, type OutboxItem } from "../logic/outbox";
import { useRealtimeActions } from "../realtime/RealtimeProvider";
import { feel } from "../ui/haptics";

export type OutgoingMessage = {
  conversationId: string;
  body: string;
  attachments: MessageAttachment[];
  images?: InlineImage[];
  parentId?: string;
  /** My messages with the same words already on screen (see `OutboxItem.baseline`). */
  baseline: string[];
};

type Outbox = {
  items: OutboxItem[];
  send: (message: OutgoingMessage) => void;
  retry: (localId: string) => void;
  drop: (localId: string) => void;
  /** Items whose message arrived another way: they are done. */
  settle: (localIds: string[]) => void;
  /** What was being written in a conversation (or a thread), kept while the app runs. */
  draft: (key: string) => string;
  keepDraft: (key: string, text: string) => void;
};

const OutboxContext = createContext<Outbox | null>(null);

let counter = 0;
function localId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}

export function OutboxProvider({ children }: { children: ReactNode }) {
  const { sendMessage } = useApi();
  const [items, dispatch] = useReducer(outboxReducer, []);
  const latest = useRef(items);
  useEffect(() => {
    latest.current = items;
  });
  const drafts = useRef(new Map<string, string>());
  const { emit } = useRealtimeActions();

  const post = useCallback(
    (item: OutboxItem) => {
      sendMessage(item.conversationId, item.body, {
        attachments: item.attachments.flatMap((a) => (a.fileId ? [a.fileId] : [])),
        parentMessageId: item.parentId,
      }).then(
        (message) => {
          // Into the screens first, then out of the outbox, so the row never blinks out in between.
          emit({ type: "message", change: "created", conversationId: item.conversationId, message: { ...message, fresh: true } });
          dispatch({ type: "sent", localId: item.localId });
        },
        () => {
          feel("failure");
          dispatch({ type: "failed", localId: item.localId });
        },
      );
    },
    [emit, sendMessage],
  );

  const send = useCallback(
    (message: OutgoingMessage) => {
      const item: OutboxItem = { ...message, localId: localId(), state: "sending", createdAt: new Date().toISOString() };
      dispatch({ type: "queued", item });
      post(item);
    },
    [post],
  );

  const retry = useCallback(
    (id: string) => {
      const item = latest.current.find((i) => i.localId === id);
      if (!item || item.state !== "failed") return;
      dispatch({ type: "retried", localId: id });
      post(item);
    },
    [post],
  );

  const drop = useCallback((id: string) => dispatch({ type: "dropped", localId: id }), []);
  const settle = useCallback((ids: string[]) => ids.forEach((id) => dispatch({ type: "sent", localId: id })), []);
  const draft = useCallback((key: string) => drafts.current.get(key) ?? "", []);
  const keepDraft = useCallback((key: string, text: string) => {
    if (text) drafts.current.set(key, text);
    else drafts.current.delete(key);
  }, []);

  const value = useMemo(
    () => ({ items, send, retry, drop, settle, draft, keepDraft }),
    [items, send, retry, drop, settle, draft, keepDraft],
  );
  return <OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>;
}

export function useOutbox(): Outbox {
  const outbox = useContext(OutboxContext);
  if (!outbox) throw new Error("useOutbox outside OutboxProvider");
  return outbox;
}
