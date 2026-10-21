/**
 * The desktop app's one bell for every instance (Théo, 2026-10-21; ADR 0007): the open instance's
 * notifications, already mapped by the interface, with every other instance's, newest first.
 *
 * The other instances' pages are merged with the phone's rule (`mergeInboxes`): an instance with more
 * to fetch bounds the list, so none of another instance's older items jumps ahead of what is still to
 * come. The mapping is the caller's (`toApp`), which keeps this free of the interface's modules.
 */
import { mergeInboxes } from "@ruchoir/client/inbox";
import type { ApiNotification } from "@ruchoir/client";

/** One other instance's first page of notifications. */
export type OtherFeed = { instanceId: string; label: string; items: ApiNotification[]; next?: string };

export function commonBell<T extends { createdAt: string }>(
  own: T[],
  others: OtherFeed[],
  toApp: (n: ApiNotification, instanceId: string, instanceLabel: string) => T,
): T[] {
  const labels = new Map(others.map((o) => [o.instanceId, o.label]));
  const { items } = mergeInboxes(others.map(({ instanceId, items, next }) => ({ instanceId, items, next })));
  const theirs = items.map((n) => toApp(n, n.instanceId, labels.get(n.instanceId) ?? ""));
  // Newest first; at the same instant the open instance's first.
  return [...own, ...theirs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
