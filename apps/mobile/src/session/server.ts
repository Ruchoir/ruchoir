/**
 * Turn what a person typed as their instance's address into an origin the app can call.
 *
 * Forgiving where it costs nothing (capitals, spaces, a pasted page address, no scheme at all) and
 * strict where it matters: plain `http://` is refused, since the session token would cross the
 * network readable, and so is anything that is not a host name with a dot in it.
 *
 * Written without `URL`, so it behaves the same under Node's test runner and on a phone.
 */
export type ServerCheck = { ok: true; origin: string } | { ok: false; reason: "empty" | "insecure" | "invalid" };

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/;

export function normalizeServer(input: string): ServerCheck {
  const text = input.trim().toLowerCase();
  if (!text) return { ok: false, reason: "empty" };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(text)?.[1];
  if (scheme === "http") return { ok: false, reason: "insecure" };
  if (scheme && scheme !== "https") return { ok: false, reason: "invalid" };
  const authority = text.slice(scheme ? scheme.length + 3 : 0).split(/[/?#]/)[0];
  if (!HOST.test(authority)) return { ok: false, reason: "invalid" };
  return { ok: true, origin: `https://${authority.replace(/:443$/, "")}` };
}
