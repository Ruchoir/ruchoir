/**
 * The Discussions list (mockup 12): channels and direct conversations in one list, with the filters
 * of the mockup and a search over names.
 */
import type { Channel, DirectMessage, Message } from "@ruchoir/client";

import { plainExcerpt } from "./inline.ts";

export type ConversationFilter = "all" | "unread" | "groups" | "people";

export type ConversationItem = {
  id: string;
  /** A channel, a conversation with one person, or one with several. */
  kind: "channel" | "person" | "group";
  name: string;
  unread: number;
  /** When the last message was written, for the order and the time on the row. */
  at?: string;
  preview?: { author?: string; text: string; mine: boolean };
  /** The other person, for a one-to-one conversation. */
  userId?: string;
  presence?: DirectMessage["presence"];
};

/**
 * Channels the person is in (with their latest message, fetched apart since the channel list carries
 * none) and their direct conversations (which carry their own preview).
 */
export function buildConversations(
  channels: Channel[],
  dms: DirectMessage[],
  latest: Record<string, Pick<Message, "author" | "body" | "createdAt" | "kind"> | undefined>,
): ConversationItem[] {
  const fromChannels = channels
    .filter((c) => c.member !== false)
    .map((c): ConversationItem => {
      const last = latest[c.id];
      // A system line ("the channel was created") has no words of anyone's to preview.
      const text = last && last.kind !== "system" ? plainExcerpt(last.body) : "";
      return {
        id: c.id,
        kind: "channel",
        name: c.name,
        unread: c.unread,
        at: last?.createdAt,
        preview: text ? { author: last!.author, text, mine: false } : undefined,
      };
    });
  const fromDms = dms.map(
    (d): ConversationItem => ({
      id: d.id,
      kind: d.userId ? "person" : "group",
      name: d.name,
      unread: d.unread,
      at: d.lastMessage?.at,
      preview: d.lastMessage ? { text: d.lastMessage.excerpt, mine: d.lastMessage.mine } : undefined,
      userId: d.userId,
      presence: d.presence,
    }),
  );
  return [...fromChannels, ...fromDms];
}

/** Lower case, accents dropped: "Léa" and "lea" are the same search. */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function listConversations(items: ConversationItem[], filter: ConversationFilter, query: string): ConversationItem[] {
  const q = fold(query.trim());
  return items
    .filter((c) => {
      if (filter === "unread" && c.unread === 0) return false;
      if (filter === "groups" && c.kind === "person") return false;
      if (filter === "people" && c.kind !== "person") return false;
      return !q || fold(c.name).includes(q);
    })
    .sort((a, b) => {
      if (a.at && b.at) return b.at.localeCompare(a.at);
      if (a.at || b.at) return a.at ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
