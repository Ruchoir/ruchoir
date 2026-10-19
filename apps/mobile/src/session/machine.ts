/**
 * Where the app stands with its instance, as a plain reducer so it can be tested without a phone.
 *
 * - `booting`: reading the Keychain.
 * - `needsServer`: no instance chosen yet (or the person asked to change it).
 * - `signedOut`: an instance, no session; `reason: "expired"` when a 401 ended one, `"signIn"` when
 *   the person left the second factor for the password, `"locked"` when the app lock signed out (a
 *   forgotten PIN, too many wrong ones): all open the sign-in, not the welcome.
 * - `mfa`: the password passed, a second factor is asked for.
 * - `signedIn`: a session, and the account it belongs to.
 */
import type { MfaMethod, SessionUser } from "@ruchoir/client";

export type SessionState =
  | { kind: "booting" }
  | { kind: "needsServer" }
  | { kind: "signedOut"; server: string; reason?: "expired" | "signIn" | "locked" }
  | { kind: "mfa"; server: string; mfaToken: string; methods: MfaMethod[] }
  | { kind: "signedIn"; server: string; user: SessionUser };

export type SessionEvent =
  | { type: "restored"; server: string | null; user: SessionUser | null }
  | { type: "serverChosen"; server: string }
  | { type: "changeServer" }
  | { type: "mfaRequired"; mfaToken: string; methods: MfaMethod[] }
  | { type: "authenticated"; user: SessionUser }
  /** The account changed from this app (name, status, zone): the screens show it at once. */
  | { type: "userUpdated"; patch: Partial<SessionUser> }
  | { type: "unauthorized" }
  | { type: "signedOut"; reason?: "locked" };

export function sessionReducer(state: SessionState, event: SessionEvent): SessionState {
  const server = "server" in state ? state.server : null;
  switch (event.type) {
    case "restored":
      if (!event.server) return { kind: "needsServer" };
      return event.user
        ? { kind: "signedIn", server: event.server, user: event.user }
        : { kind: "signedOut", server: event.server };
    case "serverChosen":
      return { kind: "signedOut", server: event.server };
    case "changeServer":
      return { kind: "needsServer" };
    case "mfaRequired":
      return server ? { kind: "mfa", server, mfaToken: event.mfaToken, methods: event.methods } : state;
    case "authenticated":
      return server ? { kind: "signedIn", server, user: event.user } : state;
    case "userUpdated":
      return state.kind === "signedIn" ? { ...state, user: { ...state.user, ...event.patch } } : state;
    case "unauthorized":
      // Only a live session can expire; anything else is already where a 401 would send it.
      return state.kind === "signedIn" ? { kind: "signedOut", server: state.server, reason: "expired" } : state;
    case "signedOut":
      if (!server) return { kind: "needsServer" };
      if (event.reason) return { kind: "signedOut", server, reason: event.reason };
      return state.kind === "mfa" ? { kind: "signedOut", server, reason: "signIn" } : { kind: "signedOut", server };
  }
}
