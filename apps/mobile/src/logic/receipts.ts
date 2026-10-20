/**
 * Who read my last message, under it: "Seen" in a one-to-one conversation, "Read by ..." in a group
 * or a channel, once someone's read cursor has reached it. Only when that message is the newest one:
 * an answer below it already says so. The wording is the web's (`ReadReceipt`).
 */
import type { ReadCursor } from "@ruchoir/client";

type FeedMessage = { id: string; authorId?: string; kind?: string };

/** The id of my message to mark "Seen", or null. `messages` oldest first. */
export function seenMessageId(cursors: ReadCursor[], messages: FeedMessage[], myUserId: string): string | null {
  const receipt = readReceipt(cursors, messages, myUserId);
  return receipt && receipt.readers.length > 0 ? receipt.id : null;
}

/**
 * My newest message and the people (user ids) whose cursor has reached it, or null when the newest
 * message is not mine. `messages` oldest first.
 */
export function readReceipt(cursors: ReadCursor[], messages: FeedMessage[], myUserId: string): { id: string; readers: string[] } | null {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind !== "system") {
      last = i;
      break;
    }
  }
  if (last === -1 || messages[last].authorId !== myUserId) return null;
  const readers: string[] = [];
  for (const cursor of cursors) {
    if (cursor.userId === myUserId || !cursor.lastReadMessageId) continue;
    const at = messages.findIndex((m) => m.id === cursor.lastReadMessageId);
    if (at >= last) readers.push(cursor.userId);
  }
  return { id: messages[last].id, readers };
}

/**
 * How a receipt reads, from how many read it out of how many could: a count means nothing without
 * its total. One or two are named (the answer to "has the person I am waiting on seen this"), more
 * are counted. `audience` leaves me out.
 */
export function receiptWording(readers: number, audience: number): "read" | "everyone" | "one" | "two" | "some" {
  if (audience <= 1) return "read";
  if (readers >= audience) return "everyone";
  if (readers === 1) return "one";
  if (readers === 2) return "two";
  return "some";
}
