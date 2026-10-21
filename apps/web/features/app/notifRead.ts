/**
 * Notifications read on another device (`notification.read`): mark them read in the list on screen.
 * Returns the same list when nothing changes, so nothing renders again.
 */
export function applyNotificationsRead<T extends { id: string; read: boolean }>(
  list: T[],
  read: { ids: string[]; all: boolean },
): T[] {
  const ids = new Set(read.ids);
  const hit = (n: T) => !n.read && (read.all || ids.has(n.id));
  if (!list.some(hit)) return list;
  return list.map((n) => (hit(n) ? { ...n, read: true } : n));
}
