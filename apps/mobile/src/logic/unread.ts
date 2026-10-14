/**
 * Where what is new starts. The conversation list knows how many messages are unread; the feed,
 * oldest first, knows which ones: the newest messages written by others, system lines aside.
 */

type FeedMessage = { id: string; authorId?: string; kind?: string };

function fromOthers(m: FeedMessage, myUserId: string): boolean {
  return m.kind !== "system" && m.authorId !== myUserId;
}

/**
 * The first unread message: the `unread`-th newest message from someone else. When more are unread
 * than are loaded, the oldest loaded one, so the line still shows where reading should start.
 */
export function firstUnreadId(messages: FeedMessage[], unread: number, myUserId: string): string | null {
  if (unread <= 0) return null;
  let count = 0;
  let oldest: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!fromOthers(m, myUserId)) continue;
    count += 1;
    oldest = m.id;
    if (count === unread) return m.id;
  }
  return oldest;
}

/** How many messages from others came after `id`: the count on the "new messages" pill. */
export function countNewer(messages: FeedMessage[], id: string, myUserId: string): number {
  const at = messages.findIndex((m) => m.id === id);
  if (at === -1) return 0;
  return messages.slice(at + 1).filter((m) => fromOthers(m, myUserId)).length;
}
