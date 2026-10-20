/**
 * The list of signed-in instances the app hands its extensions (ADR 0007): the iPhone's notification
 * service and widgets read it in Swift, Android's background task and widgets here. Free of the
 * native modules so Node tests it.
 */

/** One signed-in instance, as the extensions need it: where to ask, and with which token. */
export type SharedAccount = { server: string; token: string };

export function serializeSharedAccounts(accounts: SharedAccount[]): string {
  return JSON.stringify(accounts.map(({ server, token }) => ({ server, token })));
}

/** The list read back; an entry that is not a pair of strings is left out, a damaged list is empty. */
export function parseSharedAccounts(json: string | null): SharedAccount[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (e): e is SharedAccount => typeof e?.server === "string" && typeof e?.token === "string" && e.server.startsWith("https://"),
    );
  } catch {
    return [];
  }
}

/**
 * Ask every instance at once and keep what the ones that answered said: an instance that is down or
 * signed out never keeps the others' notifications from showing.
 */
export async function fromEvery<T>(accounts: SharedAccount[], ask: (account: SharedAccount) => Promise<T>): Promise<{ account: SharedAccount; value: T }[]> {
  const results = await Promise.allSettled(accounts.map(async (account) => ({ account, value: await ask(account) })));
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}
