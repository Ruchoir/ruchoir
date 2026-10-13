/**
 * The line under a message that has a thread: how many replies, the last few faces, the time of the
 * last one. Kept in step live, as the web does: an arrival moves the count, the faces (newest first,
 * one per person, three at most) and the time; a reply taken back only lowers the count, since it
 * says nothing of whether its author has others there, and the next read settles it.
 */
import type { Message } from "@ruchoir/client";

const MAX_FACES = 3;

type Thread = Pick<Message, "replies" | "replyAuthors" | "lastReplyAt">;

export function bumpReplies<M extends Thread>(root: M, delta: 1 | -1, author?: string, at?: string): M {
  const count = Math.max(0, (root.replies ?? 0) + delta);
  if (count === 0) return { ...root, replies: undefined, replyAuthors: undefined, lastReplyAt: undefined };
  const arrival = delta > 0;
  return {
    ...root,
    replies: count,
    replyAuthors:
      arrival && author ? [author, ...(root.replyAuthors ?? []).filter((a) => a !== author)].slice(0, MAX_FACES) : root.replyAuthors,
    lastReplyAt: arrival && at ? at : root.lastReplyAt,
  };
}

/** The replies already counted under their root, and those already taken back, on this screen. */
export type ReplyTally = { counted: Set<string>; gone: Set<string> };

/**
 * How a live message moves the count under its root: +1 for a reply seen for the first time (the
 * same reply comes twice when I send it: the server's answer, then the live stream), -1 once for one
 * deleted, nothing for an edit or for a message that is no reply.
 */
export function replyDelta(
  m: { id: string; parentId?: string; deleted?: boolean },
  change: "created" | "updated" | "deleted",
  tally: ReplyTally,
): 1 | -1 | 0 {
  if (!m.parentId) return 0;
  if (m.deleted) {
    if (tally.gone.has(m.id)) return 0;
    tally.gone.add(m.id);
    return -1;
  }
  if (change !== "created" || tally.counted.has(m.id)) return 0;
  tally.counted.add(m.id);
  return 1;
}
