/**
 * The preferences that follow an account across devices, and the one rule every app reconciles them
 * with (`GET` / `PATCH /me/preferences`).
 *
 * A document is the server's: wire keys (`locale`, `space_order`, `calendar_duration`, ...) to
 * values. Each app maps its own settings to the keys it knows and leaves the others alone: a phone
 * that never had a rail order must not erase the one the web keeps. What describes the screen (the
 * theme, the text size) is never in it.
 *
 * Kept free of any runtime so Node tests it.
 */

/** A preferences document, or a change to one; `null` puts a key back to its default. */
export type AccountPrefsDoc = Record<string, unknown>;

function pick(doc: AccountPrefsDoc, keys: readonly string[]): AccountPrefsDoc {
  const out: AccountPrefsDoc = {};
  for (const key of keys) if (key in doc) out[key] = doc[key];
  return out;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * At sign-in, what to take from the server (`apply`) and what to send it (`push`), over `keys` only.
 *
 * - `shared` (an app with several instances, once the person chose there): the app's values are the
 *   person's, sent to every instance; only the ones the server does not already hold go up.
 * - The server holds none of `keys` yet (first device on this account, or a server just upgraded):
 *   this device's go up, so nobody loses their arrangement.
 * - Otherwise the server's win; a key it does not hold comes back as `null`, its default.
 */
export function reconcileAccountPrefs(opts: {
  local: AccountPrefsDoc;
  server: AccountPrefsDoc;
  keys: readonly string[];
  shared: boolean;
}): { apply: AccountPrefsDoc; push: AccountPrefsDoc } {
  const { local, server, keys, shared } = opts;
  const mine = pick(local, keys);
  const theirs = pick(server, keys);
  if (shared) {
    const push: AccountPrefsDoc = {};
    for (const [key, value] of Object.entries(mine)) if (!same(value, theirs[key])) push[key] = value;
    return { apply: {}, push };
  }
  if (Object.keys(theirs).length === 0) return { apply: {}, push: mine };
  const apply: AccountPrefsDoc = {};
  for (const key of keys) apply[key] = key in theirs ? theirs[key] : null;
  return { apply, push: {} };
}

/** Changes not sent yet, with a newer one: the later value of a key wins. */
export function mergePending(pending: AccountPrefsDoc, patch: AccountPrefsDoc): AccountPrefsDoc {
  return { ...pending, ...patch };
}
