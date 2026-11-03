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
 * At sign-in (and again after a lost connection), what to take from the server (`apply`) and what
 * to send it (`push`), over `keys` only.
 *
 * - `first`: this device has never synced with this account. Nobody's arrangement is lost: the
 *   server's values are taken for the keys it holds, and this device sends the ones it chose (those
 *   that differ from `defaults`) for the keys the server does not hold yet.
 * - Otherwise the account is the reference: the server's values win, and a key it no longer holds
 *   comes back as `null`, its default (someone reset it on another device).
 *
 * The device never imposes its own values after its first sync: a change made on the web while the
 * phone was closed is what the phone shows when it opens.
 */
export function reconcileAccountPrefs(opts: {
  local: AccountPrefsDoc;
  server: AccountPrefsDoc;
  keys: readonly string[];
  defaults: AccountPrefsDoc;
  first: boolean;
}): { apply: AccountPrefsDoc; push: AccountPrefsDoc } {
  const { local, server, keys, defaults, first } = opts;
  const theirs = pick(server, keys);
  if (first) {
    const push: AccountPrefsDoc = {};
    for (const key of keys) {
      if (key in theirs || !(key in local)) continue;
      if (!same(local[key], defaults[key] ?? null)) push[key] = local[key];
    }
    return { apply: theirs, push };
  }
  const apply: AccountPrefsDoc = {};
  for (const key of keys) apply[key] = key in theirs ? theirs[key] : null;
  return { apply, push: {} };
}

/** Changes not sent yet, with a newer one: the later value of a key wins. */
export function mergePending(pending: AccountPrefsDoc, patch: AccountPrefsDoc): AccountPrefsDoc {
  return { ...pending, ...patch };
}
