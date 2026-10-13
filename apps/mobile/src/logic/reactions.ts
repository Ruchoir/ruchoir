/**
 * A tap on a reaction, applied on screen before the server hears of it: mine is added or removed,
 * the count follows, an empty pill goes away. Applied twice, it lands where it started.
 */
import type { Reaction } from "@ruchoir/client";

export function toggleReaction(reactions: Reaction[] | undefined, emoji: string, myName: string): Reaction[] {
  const list = reactions ?? [];
  const existing = list.find((r) => r.emoji === emoji);
  if (!existing) return [...list, { emoji, count: 1, mine: true, users: [myName] }];
  if (existing.mine) {
    if (existing.count <= 1) return list.filter((r) => r !== existing);
    return list.map((r) =>
      r === existing ? { ...r, count: r.count - 1, mine: false, users: r.users?.filter((u) => u !== myName) } : r,
    );
  }
  return list.map((r) => (r === existing ? { ...r, count: r.count + 1, mine: true, users: [...(r.users ?? []), myName] } : r));
}

/**
 * Someone else's reaction, arriving live: their name joins or leaves the pill and the count follows.
 * Mine never comes this way: it is on screen already.
 */
export function applyReactionDelta(reactions: Reaction[] | undefined, emoji: string, added: boolean, name: string): Reaction[] {
  const list = reactions ?? [];
  const existing = list.find((r) => r.emoji === emoji);
  if (added) {
    if (!existing) return [...list, { emoji, count: 1, users: [name] }];
    return list.map((r) => (r === existing ? { ...r, count: r.count + 1, users: [...(r.users ?? []), name] } : r));
  }
  if (!existing) return list;
  if (existing.count <= 1) return list.filter((r) => r !== existing);
  return list.map((r) => {
    if (r !== existing) return r;
    const users = r.users ? [...r.users] : undefined;
    const at = users?.lastIndexOf(name) ?? -1;
    if (users && at !== -1) users.splice(at, 1);
    return { ...r, count: r.count - 1, users };
  });
}
