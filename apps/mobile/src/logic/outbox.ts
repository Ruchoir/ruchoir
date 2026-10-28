/**
 * Messages on their way: written, shown at once, and kept until the server has them.
 *
 * A message goes in the outbox when it is sent and leaves it when the server answers. A failure
 * keeps it, marked, until it is retried or dropped. The API takes no idempotency key, so the outbox
 * also recognises its own message when it arrives some other way (the live stream before the HTTP
 * answer, or a send whose answer was lost): from then on the item is the message, and a retry
 * would post it twice.
 */
import type { ApiMessage, InlineImage, MessageAttachment } from "@ruchoir/client";

export type OutboxItem = {
  localId: string;
  conversationId: string;
  body: string;
  /** Files already uploaded, sent with the text, in order. */
  attachments: MessageAttachment[];
  /** Those of them that are pictures, drawn as pictures while the message goes. */
  images?: InlineImage[];
  /** The message this one answers, for a thread reply. */
  parentId?: string;
  /** A thread reply sent to its channel too. */
  alsoInChannel?: boolean;
  state: "sending" | "failed";
  createdAt: string;
  /**
   * My messages with the same words already on screen when this one was sent: none of them can be
   * it, however alike.
   */
  baseline: string[];
};

export type OutboxEvent =
  | { type: "queued"; item: OutboxItem }
  | { type: "sent"; localId: string }
  | { type: "failed"; localId: string }
  | { type: "retried"; localId: string }
  | { type: "dropped"; localId: string };

export function outboxReducer(items: OutboxItem[], event: OutboxEvent): OutboxItem[] {
  switch (event.type) {
    case "queued":
      return [...items, event.item];
    case "sent":
    case "dropped":
      return items.filter((i) => i.localId !== event.localId);
    case "failed":
      return items.map((i) => (i.localId === event.localId ? { ...i, state: "failed" } : i));
    case "retried":
      return items.map((i) => (i.localId === event.localId ? { ...i, state: "sending" } : i));
  }
}

/** A message as the outbox compares it: who wrote it, its words, its files, its thread. */
export type ArrivedMessage = {
  id: string;
  authorId?: string;
  body: string;
  parentId?: string;
  attachments?: { fileId?: string }[];
  images?: { fileId?: string }[];
};

function fileKey(files: { fileId?: string }[]): string {
  return files
    .map((f) => f.fileId ?? "")
    .sort()
    .join(",");
}

/**
 * The items whose message is already among `messages` (oldest first), each matched to its own:
 * mine, the same words, files and thread, not one that was there before it was sent, and not one
 * an earlier item already claimed. Local id to message id.
 */
export function arrivedIds(items: OutboxItem[], messages: ArrivedMessage[], myUserId: string): Map<string, string> {
  const claimed = new Map<string, string>();
  const taken = new Set<string>();
  for (const item of items) {
    const body = item.body.trim();
    const files = fileKey(item.attachments);
    const match = messages.find(
      (m) =>
        m.authorId === myUserId &&
        !taken.has(m.id) &&
        !item.baseline.includes(m.id) &&
        m.body.trim() === body &&
        (m.parentId ?? undefined) === item.parentId &&
        fileKey([...(m.attachments ?? []), ...(m.images ?? [])]) === files,
    );
    if (match) {
      claimed.set(item.localId, match.id);
      taken.add(match.id);
    }
  }
  return claimed;
}

export type PendingRow = { localId: string; state: OutboxItem["state"]; message: ApiMessage };

/** The rows to draw for one conversation (or one thread, by its root), as messages by me. */
export function pendingRows(
  items: OutboxItem[],
  conversationId: string,
  parentId: string | undefined,
  me: { id: string; name: string },
): PendingRow[] {
  return items
    .filter((i) => i.conversationId === conversationId && i.parentId === parentId)
    .map((i) => {
      const pictures = new Set((i.images ?? []).map((img) => img.fileId));
      const files = i.attachments.filter((a) => !pictures.has(a.fileId));
      return {
        localId: i.localId,
        state: i.state,
        message: {
          id: `local:${i.localId}`,
          author: me.name,
          authorId: me.id,
          createdAt: i.createdAt,
          body: i.body,
          attachments: files.length > 0 ? files : undefined,
          images: i.images?.length ? i.images : undefined,
          parentId: i.parentId,
          alsoInChannel: i.alsoInChannel || undefined,
        },
      };
    });
}
