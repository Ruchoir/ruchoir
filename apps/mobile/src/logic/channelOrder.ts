/**
 * The order of a space's channels, as the web's sidebar lets those who hold `space.settings` change
 * it: one step up or down. Pure; the server keeps the list (`PUT /channel-order`) and is the judge.
 */

/** The order with `id` one step up (-1) or down (1), or null when it is already at that end or unknown. */
export function stepChannel(order: readonly string[], id: string, step: -1 | 1): string[] | null {
  const from = order.indexOf(id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= order.length) return null;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Whether the channel order is offered: the permission when the instance has them, the legacy role rule otherwise. */
export function channelOrderDoor(supported: boolean, gates: { reorderChannels: boolean }, legacyAdmin: boolean): boolean {
  return supported ? gates.reorderChannels : legacyAdmin;
}
