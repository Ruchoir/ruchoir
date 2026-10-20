/**
 * React to a message: the pill changes at once, then the server is told.
 *
 * Calls for one message and one emoji go out in order, each after the last has answered: two quick
 * taps are an add then a removal, and the server must see them in that order to end where the screen
 * does. A refusal puts the message back as it was before the tap and says so.
 */
import type { ApiMessage, RuchoirClient } from "@ruchoir/client";
import { useCallback } from "react";

import { useApi } from "../api/useApi";
import { useTranslation } from "../i18n";
import { toggleReaction } from "../logic/reactions";
import { useRealtimeActions } from "../realtime/RealtimeProvider";
import { useSession } from "../session/SessionProvider";
import { feel } from "../ui/haptics";
import { useToast } from "../ui/Toast";

const queues = new Map<string, Promise<void>>();

function sendReaction(api: RuchoirClient, messageId: string, emoji: string, add: boolean): Promise<void> {
  const key = `${api.options().baseUrl} ${messageId}:${emoji}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => (add ? api.addReaction(messageId, emoji) : api.removeReaction(messageId, emoji)));
  queues.set(key, next);
  void next
    .catch(() => {})
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  return next;
}

/** `react(conversationId, message, emoji)`: add my reaction, or take it back if it is there. */
export function useReact(): (conversationId: string, message: ApiMessage, emoji: string) => void {
  const api = useApi();
  const { emit } = useRealtimeActions();
  const toast = useToast();
  const { t } = useTranslation();
  const { state } = useSession();
  const myName = state.kind === "signedIn" ? state.user.name : null;

  return useCallback(
    (conversationId, message, emoji) => {
      if (!myName) return;
      const wasMine = !!message.reactions?.find((r) => r.emoji === emoji)?.mine;
      const reactions = toggleReaction(message.reactions, emoji, myName);
      emit({ type: "patched", conversationId, message: { ...message, reactions: reactions.length > 0 ? reactions : undefined } });
      feel("choice");
      sendReaction(api, message.id, emoji, !wasMine).catch(() => {
        emit({ type: "patched", conversationId, message });
        toast(t("message.reactionFailed"), "failure");
      });
    },
    [api, emit, myName, t, toast],
  );
}
