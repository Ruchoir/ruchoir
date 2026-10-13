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
