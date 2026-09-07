/**
 * Emailed authentication links.
 *
 * The app is a state machine rather than a set of routes, with one exception: the API emails
 * absolute links back into the client (`/verify-email?token=…`, `/reset-password?token=…` and
 * `/invite?token=…`, built from `RUCHOIR_PUBLIC_BASE_URL`). The Rust API serves `index.html` for any
 * unknown path, so all three land on this bundle; this helper turns the location into the screen to
 * show.
 *
 * Unlike `lib/dev/deeplink.ts` this is a production affordance: it is the only way a user can act on
 * a verification, reset or invitation email. The token is never persisted, and the address is
 * rewritten to `/` once the screen has it so a copied URL, a reload or a shared history entry
 * carries no token.
 */

/** An emailed link the client must act on, resolved from the current location. */
export type AuthLink =
  | { kind: "verify-email"; token: string }
  | { kind: "reset-password"; token: string }
  | { kind: "invite"; token: string };

/** Path (with or without the export's trailing slash) to the screen that handles it. */
const ROUTES: Record<string, AuthLink["kind"]> = {
  "/verify-email": "verify-email",
  "/reset-password": "reset-password",
  "/invite": "invite",
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

/**
 * Where a pending invitation token is held between page loads.
 *
 * The other two emailed tokens are acted on immediately and never outlive the screen that received
 * them. An invitation is different: someone arriving without an account has to register, and
 * confirming their address means following a second emailed link, which reloads the bundle and would
 * otherwise lose the invitation. They would then land in the "create your first space" onboarding,
 * having just been invited into one.
 *
 * `sessionStorage`, not `localStorage`: the token dies with the tab, so it never lingers on a shared
 * machine. Every access is guarded, because a browser in private mode (or with site data blocked)
 * throws on the accessor itself rather than returning null. Losing it is not a failure: the
 * invitation link in the mailbox still works, and this only spares the user that round trip.
 */
const INVITE_KEY = "ruchoir.invite";

/** Hold an invitation token across the address-confirmation round trip. */
export function rememberInvite(token: string): void {
  try {
    sessionStorage.setItem(INVITE_KEY, token);
  } catch {
    // No session storage available: the invitation link itself remains the fallback.
  }
}

/** The invitation token held for this tab, if any. */
export function readRememberedInvite(): string {
  try {
    return sessionStorage.getItem(INVITE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Drop the held invitation, once it has been accepted, refused or abandoned. */
export function forgetInvite(): void {
  try {
    sessionStorage.removeItem(INVITE_KEY);
  } catch {
    // Nothing was stored in the first place.
  }
}
