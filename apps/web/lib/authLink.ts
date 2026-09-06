/**
 * Emailed authentication links.
 *
 * The app is a state machine rather than a set of routes, with one exception: the API emails
 * absolute links back into the client (`/verify-email?token=…` and `/reset-password?token=…`, built
 * from `RUCHOIR_PUBLIC_BASE_URL`). The Rust API serves `index.html` for any unknown path, so both
 * links land on this bundle; this helper turns the location into the screen to show.
 *
 * Unlike `lib/dev/deeplink.ts` this is a production affordance: it is the only way a user can act on
 * a verification or reset email. The token is never persisted, and the address is rewritten to `/`
 * once the screen has it so a copied URL, a reload or a shared history entry carries no token.
 */

/** An emailed link the client must act on, resolved from the current location. */
export type AuthLink = { kind: "verify-email"; token: string } | { kind: "reset-password"; token: string };

/** Path (with or without the export's trailing slash) to the screen that handles it. */
const ROUTES: Record<string, AuthLink["kind"]> = {
  "/verify-email": "verify-email",
  "/reset-password": "reset-password",
};

/**
 * The emailed link the current location points at, or `null` for a normal app load. A known path
 * without a usable token still resolves, so the screen can explain that the link is incomplete
 * rather than dropping the user on the login with no context.
 */
export function readAuthLink(): AuthLink | null {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const kind = ROUTES[path];
  if (!kind) return null;
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  return { kind, token };
}

/**
 * Drop the link (path and token) from the address bar without reloading, once the screen holds the
 * token. Keeps the token out of the history entry, out of a copied URL and out of any `Referer`.
 */
export function clearAuthLink(): void {
  if (typeof window === "undefined") return;
  window.history.replaceState(null, "", "/");
}
