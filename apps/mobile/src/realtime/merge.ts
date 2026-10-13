/**
 * Fold messages that arrived (live, or from a refetch after a reconnection) into the ones on screen.
 *
 * By id, so a message delivered twice (the socket, then the catch-up) is drawn once, and the later
 * copy wins, which is how an edit or a deletion replaces what was shown. Sorted by time, ties by id.
 */
import type { Message } from "@ruchoir/client";

export function mergeMessages<M extends Pick<Message, "id" | "createdAt">>(existing: M[], incoming: M[]): M[] {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
