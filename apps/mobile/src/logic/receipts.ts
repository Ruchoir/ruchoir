/**
 * "Seen" in a one-to-one conversation: under my last message, once the other person's read cursor
 * has reached it. Only when that message is the newest one: an answer below it already says so.
 */
import type { ReadCursor } from "@ruchoir/client";

type FeedMessage = { id: string; authorId?: string; kind?: string };

/** The id of my message to mark "Seen", or null. `messages` oldest first. */
export function seenMessageId(cursors: ReadCursor[], messages: FeedMessage[], myUserId: string): string | null {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind !== "system") {
      last = i;
      break;
    }
  }
  if (last === -1 || messages[last].authorId !== myUserId) return null;
  for (const cursor of cursors) {
    if (cursor.userId === myUserId || !cursor.lastReadMessageId) continue;
    const at = messages.findIndex((m) => m.id === cursor.lastReadMessageId);
    if (at >= last) return messages[last].id;
  }
  return null;
}
