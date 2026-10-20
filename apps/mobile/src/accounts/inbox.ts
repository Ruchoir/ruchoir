/**
 * One inbox for every instance (ADR 0007): the pages each instance returned, merged newest first.
 * Free of React so Node tests it.
 *
 * Each instance pages its own inbox. Merged, a page boundary must not let an older item of one
 * instance show above a newer one of another that is still to be fetched: so the list stops at the
 * newest of the oldest items among the instances that have more, and the rest shows once they have
 * answered for the next page.
 */
import type { ApiNotification } from "@ruchoir/client";

export type Feed = { instanceId: string; items: ApiNotification[]; next?: string };

export type InboxItem = ApiNotification & { instanceId: string; key: string };

export function mergeInboxes(feeds: Feed[]): { items: InboxItem[]; more: boolean } {
  const unfinished = feeds.filter((feed) => feed.next && feed.items.length > 0);
  const boundary = unfinished.reduce<string | null>((latest, feed) => {
    const oldest = feed.items.reduce((min, n) => (n.createdAt < min ? n.createdAt : min), feed.items[0].createdAt);
    return latest === null || oldest > latest ? oldest : latest;
  }, null);
  const items = feeds
    .flatMap((feed) => feed.items.map((n) => ({ ...n, instanceId: feed.instanceId, key: `${feed.instanceId}:${n.id}` })))
    .filter((n) => boundary === null || n.createdAt >= boundary)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key));
  return { items, more: feeds.some((feed) => !!feed.next) };
}
