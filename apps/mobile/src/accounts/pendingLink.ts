/**
 * Where a tapped notification or an app link waits for the instance it belongs to (ADR 0007).
 *
 * A tap can be about an instance other than the one on screen. The accounts switch to it first, which
 * mounts that instance's navigation afresh; the link waits here until that navigation is ready and
 * takes it (`push/usePhonePush`, `navigation/useAppLinks`).
 */

export type PendingLink = { kind: "push"; data: Record<string, unknown> } | { kind: "url"; url: string };

let slot: { instanceId: string; link: PendingLink } | null = null;
const listeners = new Set<() => void>();

export function queueLink(instanceId: string, link: PendingLink): void {
  slot = { instanceId, link };
  listeners.forEach((listen) => listen());
}

/** The link waiting for this instance, taken: nobody else will see it. */
export function takeLink(instanceId: string, kind: PendingLink["kind"]): PendingLink | null {
  if (!slot || slot.instanceId !== instanceId || slot.link.kind !== kind) return null;
  const { link } = slot;
  slot = null;
  return link;
}

export function onLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
