/**
 * Which notification preferences win when an instance's are read at sign-in: the server's or the
 * app's own (`settings.notif`).
 *
 * - On the web (one instance per tab), the server's, unless it holds none yet: then the app's go up.
 * - In the desktop app, once the person has chosen theirs (`shared`), the app's, sent to every
 *   instance (Théo, 2026-10-21: notification settings are set once for all instances). Before that
 *   first choice, the first instance's are adopted, as on the web.
 *
 * Only the fields the app keeps are compared (`defaults`' keys); the server's extras (its offset) are
 * not a difference.
 */
export function reconcileNotifPrefs<T extends object>(opts: {
  local: T;
  server: T;
  defaults: T;
  shared: boolean;
}): { prefs: T; push: boolean } {
  const { local, server, defaults, shared } = opts;
  const keys = Object.keys(defaults) as (keyof T)[];
  const same = (a: T, b: T) => keys.every((k) => a[k] === b[k]);
  const pick = (from: T) => Object.fromEntries(keys.map((k) => [k, from[k]])) as T;
  if (shared) return { prefs: local, push: !same(server, local) };
  if (same(server, defaults)) return { prefs: { ...defaults, ...local }, push: true };
  return { prefs: pick(server), push: false };
}
