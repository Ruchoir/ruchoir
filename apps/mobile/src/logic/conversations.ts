/**
 * The Discussions list (mockup 12): channels and direct conversations in one list, with the filters
 * of the mockup and a search over names.
 */
import type { Channel, DirectMessage, LastMessage, SystemEvent } from "@ruchoir/client";

import { plainExcerpt } from "./inline.ts";

export type ConversationFilter = "all" | "unread" | "groups" | "people";

/**
 * The second line of a row: what was said and by whom; or, for a channel where nobody wrote since,
 * what happened there (`notice`, worded by the screen with `who` and the detail in `text`); or that
 * the last message was only files (`files`, its text empty).
 */
export type Preview = {
  author?: string;
  text: string;
  mine: boolean;
  notice?: { event?: SystemEvent; who?: string };
  files?: true;
};

export type ConversationItem = {
  id: string;
  /** A channel, a conversation with one person, or one with several. */
  kind: "channel" | "person" | "group";
  name: string;
  unread: number;
  /** When the last message was written, for the order and the time on the row. */
  at?: string;
  preview?: Preview;
  /** How many people are in it, the reader included ("Group · 8 people"). */
  members?: number;
  /** A channel only the people invited see. */
  private?: true;
  /** The others in a private conversation with several people, whose faces stand for it. */
  participants?: string[];
  /** The other person, for a one-to-one conversation. */
  userId?: string;
  presence?: DirectMessage["presence"];
};

/** A list's preview line from a conversation's latest message, as the server hands it over. */
function toPreview(last: LastMessage | undefined, withAuthor: boolean): Preview | undefined {
  if (!last) return undefined;
  if (last.notice) {
    const notice: Preview["notice"] = {};
    if (last.systemEvent) notice.event = last.systemEvent;
    if (last.author) notice.who = last.author;
    return { text: plainExcerpt(last.excerpt), mine: false, notice };
  }
  const text = plainExcerpt(last.excerpt);
  const preview: Preview = withAuthor && last.author ? { author: last.author, text, mine: last.mine } : { text, mine: last.mine };
  // A message is text or files: no text means it carried only files.
  if (!text) preview.files = true;
  return preview;
}

/**
 * Channels the person is in and their direct conversations, each with its latest message as the
 * server gives it in the lists: one request each, whatever the number of conversations.
 */
export function buildConversations(channels: Channel[], dms: DirectMessage[]): ConversationItem[] {
  const fromChannels = channels
    .filter((c) => c.member !== false)
    .map((c): ConversationItem => {
      const item: ConversationItem = {
        id: c.id,
        kind: "channel",
        name: c.name,
        unread: c.unread,
        at: c.lastMessage?.at,
        preview: toPreview(c.lastMessage, true),
      };
      if (c.memberCount !== undefined) item.members = c.memberCount;
      if (c.type === "private") item.private = true;
      return item;
    });
  const fromDms = dms.map((d): ConversationItem => {
    const item: ConversationItem = {
      id: d.id,
      kind: d.userId ? "person" : "group",
      name: d.name,
      unread: d.unread,
      at: d.lastMessage?.at,
      // In a group conversation, who said it matters; with one person, it is them or me.
      preview: toPreview(d.lastMessage, !d.userId),
      userId: d.userId,
      presence: d.presence,
    };
    if (!d.userId && d.participantIds?.length) {
      item.participants = d.participantIds;
      item.members = d.participantIds.length + 1;
    }
    return item;
  });
  return [...fromChannels, ...fromDms];
}

/** Lower case, accents dropped: "Léa" and "lea" are the same search. */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function listConversations(items: ConversationItem[], filter: ConversationFilter, query: string): ConversationItem[] {
  const q = fold(query.trim());
  return items
    .filter((c) => {
      if (filter === "unread" && c.unread === 0) return false;
      // Groups are the channels; people are the private conversations, with one person or several.
      if (filter === "groups" && c.kind !== "channel") return false;
      if (filter === "people" && c.kind === "channel") return false;
      return !q || fold(c.name).includes(q);
    })
    .sort((a, b) => {
      if (a.at && b.at) return b.at.localeCompare(a.at);
      if (a.at || b.at) return a.at ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
