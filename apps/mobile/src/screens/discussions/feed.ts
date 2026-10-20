/**
 * What a conversation and a thread share: their messages kept live, my messages on their way, the
 * edit of one of mine, and who is writing. Each screen loads its own messages and draws its own
 * rows; these hooks keep them true.
 */
import type { ApiMessage, Member, SessionUser } from "@ruchoir/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import { useApi } from "../../api/useApi";
import type { Editing } from "../../compose/Composer";
import { useEditRequests } from "../../compose/requests";
import { useOutbox } from "../../compose/useOutbox";
import { useTypingUsers } from "../../compose/useTyping";
import { useTranslation } from "../../i18n";
import { arrivedIds, pendingRows } from "../../logic/outbox";
import { applyReactionDelta } from "../../logic/reactions";
import { bumpReplies, replyDelta, type ReplyTally } from "../../logic/threads";
import { mergeMessages } from "../../realtime/merge";
import { useRealtimeEvent } from "../../realtime/RealtimeProvider";

/**
 * The messages on screen: those loaded, and what arrived or changed since. `belongs` says which
 * messages of the conversation this screen shows (the feed: no replies; a thread: its root and its
 * replies). A reply arriving anywhere moves the count under its root, once per reply.
 */
export function useLiveMessages(
  conversationId: string,
  loaded: ApiMessage[] | undefined,
  belongs: (m: ApiMessage) => boolean,
  me: SessionUser | null,
  members: Member[],
) {
  const { t } = useTranslation();
  const [live, setLive] = useState<ApiMessage[]>([]);
  const messages = useMemo(() => mergeMessages(loaded ?? [], live), [loaded, live]);
  const tally = useRef<ReplyTally>({ counted: new Set(), gone: new Set() });

  /** Change one message from its latest copy, when it is on screen. */
  const patch = useCallback(
    (id: string, change: (m: ApiMessage) => ApiMessage) =>
      setLive((prev) => {
        const current = prev.find((m) => m.id === id) ?? loaded?.find((m) => m.id === id);
        return current ? mergeMessages(prev, [change(current)]) : prev;
      }),
    [loaded],
  );
  const add = useCallback((more: ApiMessage[]) => setLive((prev) => mergeMessages(prev, more)), []);

  useRealtimeEvent((event) => {
    if (event.type === "message" && event.conversationId === conversationId) {
      const m = event.message;
      if (belongs(m)) add([m]);
      const delta = replyDelta(m, event.change, tally.current);
      if (delta !== 0 && m.parentId) patch(m.parentId, (root) => bumpReplies(root, delta, m.author, m.createdAt));
    } else if (event.type === "patched" && event.conversationId === conversationId && belongs(event.message)) {
      patch(event.message.id, () => event.message);
    } else if (event.type === "reaction" && event.conversationId === conversationId && event.userId !== me?.id) {
      const name = members.find((m) => m.userId === event.userId)?.name ?? t("message.someone");
      patch(event.messageId, (m) => {
        const reactions = applyReactionDelta(m.reactions, event.emoji, event.added, name);
        return { ...m, reactions: reactions.length > 0 ? reactions : undefined };
      });
    } else if (event.type === "pinned" && event.conversationId === conversationId) {
      patch(event.messageId, (m) => ({ ...m, pinned: event.pinned || undefined }));
    }
  });

  return { messages, patch, add };
}

/**
 * My messages still in the outbox for this conversation (or this thread), as rows to draw. One that
 * already arrived (live, or after a lost answer) is done and leaves the outbox.
 */
export function useOutboxRows(conversationId: string, parentId: string | undefined, messages: ApiMessage[], me: SessionUser | null) {
  const outbox = useOutbox();
  const mine = useMemo(
    () => outbox.items.filter((i) => i.conversationId === conversationId && i.parentId === parentId),
    [outbox.items, conversationId, parentId],
  );
  const arrived = useMemo(() => (me ? arrivedIds(mine, messages, me.id) : new Map<string, string>()), [mine, messages, me]);
  const { settle } = outbox;
  useEffect(() => {
    if (arrived.size > 0) settle([...arrived.keys()]);
  }, [arrived, settle]);
  const pending = useMemo(
    () => (me ? pendingRows(mine, conversationId, parentId, me).filter((row) => !arrived.has(row.localId)) : []),
    [mine, conversationId, parentId, me, arrived],
  );
  const byId = useMemo(() => new Map(pending.map((row) => [row.message.id, row])), [pending]);
  /** My messages on screen with these words, which the outbox must not take for a new one. */
  const baselineFor = useCallback(
    (body: string) => (me ? messages.filter((m) => m.authorId === me.id && m.body.trim() === body).map((m) => m.id) : []),
    [messages, me],
  );
  return { pending, byId, baselineFor, retry: outbox.retry, drop: outbox.drop };
}

/**
 * Editing one of my messages: "Edit" in its sheet puts the text in the composer (for the composer
 * whose draft is `draftKey`), and saving shows the new text at once. If the server refuses it, the
 * old text comes back and the edit can resume.
 */
export function useEditing(draftKey: string, messages: ApiMessage[], patch: (id: string, change: (m: ApiMessage) => ApiMessage) => void) {
  const { editMessage } = useApi();
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Editing | null>(null);
  useEditRequests(draftKey, (request) => setEditing({ id: request.id, body: request.body }));

  const save = useCallback(
    (id: string, body: string) => {
      setEditing(null);
      const before = messages.find((m) => m.id === id);
      if (!before || before.body.trim() === body) return;
      const files = [...(before.attachments ?? []), ...(before.images ?? [])].flatMap((f) => (f.fileId ? [f.fileId] : []));
      patch(id, (m) => ({ ...m, body, edited: true }));
      editMessage(id, body, files).then(
        (saved) => patch(id, () => saved),
        () => {
          patch(id, () => before);
          Alert.alert(t("compose.editFailed"), t("compose.editFailedText"), [
            { text: t("common.retry"), onPress: () => setEditing({ id, body }) },
            { text: t("compose.ok"), style: "cancel" },
          ]);
        },
      );
    },
    [editMessage, messages, patch, t],
  );

  return { editing, save, cancel: () => setEditing(null) };
}

/** "Léa is writing…", worded, for the line above the composer. */
export function useTypingLine(conversationId: string, me: SessionUser | null, members: Member[]): string | undefined {
  const { t } = useTranslation();
  const ids = useTypingUsers(conversationId, me?.id);
  return useMemo(() => {
    const names = ids.map((id) => members.find((m) => m.userId === id)?.name).filter((n): n is string => !!n);
    if (names.length === 0) return undefined;
    if (names.length === 1) return t("compose.typingOne", { name: names[0] });
    if (names.length === 2) return t("compose.typingTwo", { a: names[0], b: names[1] });
    return t("compose.typingMany");
  }, [ids, members, t]);
}

/** The ways a message names the reader (`@Théo Vilain`, `@Théo`, `@ThéoVilain`), lower case. */
export function useMyMentions(me: SessionUser | null): string[] {
  return useMemo(() => {
    if (!me) return [];
    const words = me.name.split(/\s+/).filter(Boolean);
    return [me.name, words[0], words.join("")].map((n) => `@${n}`.toLowerCase());
  }, [me]);
}
