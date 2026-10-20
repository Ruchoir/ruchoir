/**
 * The session, for every screen: where the person stands with an instance (`machine.ts`) and the
 * actions that move it.
 *
 * Two providers answer `useSession()` (ADR 0007):
 *
 * - {@link SignInFlow}, around the screens before sign-in: signing in to an instance, creating an
 *   account there, its second factor. It works on a candidate client of its own, pointed at the
 *   address the person types, and hands the session it obtains to the accounts (`onSignedIn`): that
 *   is how the first instance is added, and every other one.
 * - each instance's scope (`accounts/InstanceScope`), inside the app: the account signed in there,
 *   its sign-out and its password.
 *
 * Actions throw an {@link AuthFailure} whose `code` the screens turn into a sentence, so the wording
 * stays in the dictionaries and the logic stays here.
 */
import { apiErrorCode, createClient, isApiError, type MfaMethod, type RuchoirClient, type SessionUser } from "@ruchoir/client";
import { createContext, useCallback, useContext, useMemo, useReducer, useRef, useState, type ReactNode } from "react";

import { ApiProvider } from "../api/useApi";
import { canUseBrowserHandoff, signInThroughBrowser } from "../auth/browser";
import i18n from "../i18n";
import { sessionReducer, type SessionState } from "./machine";
import { normalizeServer } from "./server";

/** Why an action failed, in the API's own codes where it gave one. */
export type FailureCode =
  | "empty"
  | "insecure"
  | "invalid"
  | "unreachable"
  | "notRuchoir"
  | "outdated"
  | "invalid_credentials"
  | "too_many_attempts"
  | "email_not_verified"
  | "account_locked"
  | "invalid_code"
  | "invalid_token"
  | "email_taken"
  | "weak_password"
  | "breached_password"
  | "passkeyOnly"
  | "alreadyAdded"
  | "unknown";

export class AuthFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
  }
}

/** The second factors this app can complete. A passkey needs a native build (step 6). */
const APP_METHODS: MfaMethod[] = ["totp", "recovery"];

/** What a new account needs to be created. */
export type SignUp = { name: string; email: string; password: string; invitationToken?: string };

export type SessionApi = {
  state: SessionState;
  /**
   * The address of an account just created and not confirmed yet. Its password waits beside it in
   * memory only (never written), so the app can sign in by itself once the address is confirmed.
   */
  pendingSignUp: { email: string } | null;
  /** Create an account: `"signedIn"` when it is active at once (an invitation to that address). */
  register: (input: SignUp) => Promise<"verify" | "signedIn">;
  /** Confirm the pending address with the e-mailed code, then sign in. */
  confirmCode: (code: string) => Promise<void>;
  resendVerification: () => Promise<void>;
  /** Sign in quietly with the pending sign-up; false while the address is still unconfirmed. */
  retryPendingSignIn: () => Promise<boolean>;
  forgetPendingSignUp: () => void;
  /** The invitation pasted at sign-up, handed once to whoever accepts it after sign-in. */
  takePendingInvitation: () => string | null;
  chooseServer: (input: string) => Promise<void>;
  changeServer: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  verify: (method: "totp" | "recovery", code: string) => Promise<void>;
  /**
   * Sign in on the instance's own web page, for a second factor the app cannot run itself (a
   * passkey, `auth/browser.ts`). False when the person closed the page or declined.
   */
  signInInBrowser: () => Promise<boolean>;
  /** Sign out; `"locked"` when the app lock does it (a forgotten PIN), which the sign-in then says. */
  signOut: (reason?: "locked") => Promise<void>;
  /** The account changed from this app: shown at once on every screen. */
  updateUser: (patch: Partial<SessionUser>) => void;
  /**
   * Change the password. The server ends every session, this one included, so the app signs in again
   * with the new password (a second factor, when the account has one, is asked as at sign-in).
   */
  changePassword: (current: string, next: string) => Promise<void>;
  /** Leave the flow without signing in, when the app has another instance to go back to. */
  cancel?: () => void;
};

export const SessionContext = createContext<SessionApi | null>(null);

function failureOf(err: unknown): AuthFailure {
  if (err instanceof AuthFailure) return err;
  const code = apiErrorCode(err);
  const known: FailureCode[] = [
    "invalid_credentials",
    "too_many_attempts",
    "email_not_verified",
    "account_locked",
    "invalid_code",
    "invalid_token",
    "email_taken",
    "weak_password",
    "breached_password",
  ];
  if (code && (known as string[]).includes(code)) return new AuthFailure(code as FailureCode);
  return new AuthFailure(isApiError(err) ? "unknown" : "unreachable");
}

/** Where the flow starts: a fresh sign-in, or the instance whose session is to be renewed. */
export type FlowStart = { server: string | null; reason?: "expired" | "locked" };

type FlowProps = {
  start: FlowStart;
  /** Whether the phone already has this instance signed in, which adding again would duplicate. */
  isSignedIn: (origin: string) => boolean;
  /** The session obtained: the accounts keep it (the token is the instance's from now on). */
  onSignedIn: (done: { origin: string; token: string; user: SessionUser; invitation: string | null }) => Promise<void>;
  onCancel?: () => void;
  children: ReactNode;
};

/**
 * The sign-in flow: one candidate client, pointed at the address chosen, for every call made before
 * a session exists (the instance's capabilities, sign-in, sign-up, second factor, password reset).
 * The client is the same object throughout, so a screen holding its calls follows a change of
 * address; it never carries a token.
 */
export function SignInFlow({ start, isSignedIn, onSignedIn, onCancel, children }: FlowProps) {
  const [state, dispatch] = useReducer(
    sessionReducer,
    start,
    (from): SessionState => (from.server ? { kind: "signedOut", server: from.server, reason: from.reason } : { kind: "needsServer" }),
  );
  const [client] = useState<RuchoirClient>(() =>
    createClient({
      baseUrl: start.server ?? "",
      sessionDelivery: "token",
      locale: () => i18n.language,
    }),
  );
  const pending = useRef<{ email: string; password: string } | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const invitation = useRef<string | null>(null);
  // The address last typed at sign-in, carried to the instance's page when it takes over.
  const lastEmail = useRef("");
  /** The instance the client talks to once a choice has been checked: where a failed one goes back. */
  const connected = useRef<string | null>(start.server);

  const chooseServer = useCallback(
    async (input: string) => {
      const check = normalizeServer(input);
      if (!check.ok) throw new AuthFailure(check.reason);
      if (isSignedIn(check.origin)) throw new AuthFailure("alreadyAdded");
      client.configure({ baseUrl: check.origin });
      // A server that is refused leaves the client where it was, so the screen and the requests
      // still name the same instance.
      const refuse = (code: FailureCode) => {
        client.configure({ baseUrl: connected.current ?? "" });
        return new AuthFailure(code);
      };
      let caps;
      try {
        caps = await client.getInstanceCapabilities();
      } catch (err) {
        throw refuse(isApiError(err) ? "notRuchoir" : "unreachable");
      }
      // A web page answering 200 is not an instance: a Ruchoir always says whether it can send mail.
      if (typeof caps.emailDelivery !== "boolean") throw refuse("notRuchoir");
      if (!caps.nativeSessions) throw refuse("outdated");
      connected.current = check.origin;
      dispatch({ type: "serverChosen", server: check.origin });
    },
    [client, isSignedIn],
  );

  const forgetPendingSignUp = useCallback(() => {
    pending.current = null;
    setPendingEmail(null);
  }, []);

  const signedIn = useCallback(
    async (user: SessionUser, token: string | undefined) => {
      const origin = connected.current;
      if (!token || !origin) throw new AuthFailure("outdated");
      forgetPendingSignUp();
      const handed = invitation.current;
      invitation.current = null;
      await onSignedIn({ origin, token, user, invitation: handed });
    },
    [forgetPendingSignUp, onSignedIn],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      let result;
      lastEmail.current = email.trim();
      try {
        result = await client.login(email.trim(), password);
      } catch (err) {
        throw failureOf(err);
      }
      if (result.kind === "authenticated") return signedIn(result.user, result.sessionToken);
      // A passkey goes through the instance's page, where this build can reach it.
      const reachable = canUseBrowserHandoff() ? [...APP_METHODS, "passkey"] : APP_METHODS;
      const methods = result.methods.filter((m) => reachable.includes(m));
      if (methods.length === 0) throw new AuthFailure("passkeyOnly");
      dispatch({ type: "mfaRequired", mfaToken: result.mfaToken, methods });
    },
    [client, signedIn],
  );

  const register = useCallback(
    async ({ name, email, password, invitationToken }: SignUp) => {
      const address = email.trim();
      let result;
      try {
        result = await client.register(address, name.trim(), password, invitationToken);
      } catch (err) {
        throw failureOf(err);
      }
      invitation.current = invitationToken ?? null;
      if (result.active) {
        await signIn(address, password);
        return "signedIn" as const;
      }
      pending.current = { email: address, password };
      setPendingEmail(address);
      return "verify" as const;
    },
    [client, signIn],
  );

  const retryPendingSignIn = useCallback(async () => {
    const waiting = pending.current;
    if (!waiting) return false;
    try {
      await signIn(waiting.email, waiting.password);
      return true;
    } catch {
      // Still unconfirmed, or the network is away: the screen stays as it is.
      return false;
    }
  }, [signIn]);

  const confirmCode = useCallback(
    async (code: string) => {
      const waiting = pending.current;
      if (!waiting) throw new AuthFailure("invalid_code");
      try {
        await client.confirmEmailVerificationCode(waiting.email, code);
      } catch (err) {
        throw failureOf(err);
      }
      await signIn(waiting.email, waiting.password);
    },
    [client, signIn],
  );

  const resendVerification = useCallback(async () => {
    const waiting = pending.current;
    if (!waiting) return;
    try {
      await client.requestEmailVerification(waiting.email);
    } catch (err) {
      throw failureOf(err);
    }
  }, [client]);

  // Handed to the accounts with the session instead (`onSignedIn`).
  const takePendingInvitation = useCallback(() => null, []);

  const verify = useCallback(
    async (method: "totp" | "recovery", code: string) => {
      if (state.kind !== "mfa") return;
      try {
        const done = await (method === "totp" ? client.verifyTotp : client.verifyRecoveryCode)(state.mfaToken, code.trim());
        await signedIn(done.user, done.sessionToken);
      } catch (err) {
        const failure = failureOf(err);
        // A spent or expired challenge cannot be retried: back to the password.
        if (failure.code === "invalid_token") dispatch({ type: "signedOut" });
        throw failure;
      }
    },
    [client, signedIn, state],
  );

  const signInInBrowser = useCallback(async () => {
    if (state.kind !== "mfa" && state.kind !== "signedOut") return false;
    const handed = await signInThroughBrowser(state.server, lastEmail.current || undefined);
    if (!handed) return false;
    let done;
    try {
      done = await client.exchangeNativeCode(handed.code, handed.verifier);
    } catch (err) {
      throw failureOf(err);
    }
    await signedIn(done.user, done.sessionToken);
    return true;
  }, [client, state, signedIn]);

  // Before a session, "sign out" is leaving the second factor for the password.
  const signOut = useCallback(async () => dispatch({ type: "signedOut" }), []);
  const updateUser = useCallback(() => {}, []);
  const changePassword = useCallback(async () => {}, []);
  const changeServer = useCallback(() => dispatch({ type: "changeServer" }), []);

  const pendingSignUp = useMemo(() => (pendingEmail ? { email: pendingEmail } : null), [pendingEmail]);

  const api = useMemo<SessionApi>(
    () => ({
      state,
      pendingSignUp,
      register,
      confirmCode,
      resendVerification,
      retryPendingSignIn,
      forgetPendingSignUp,
      takePendingInvitation,
      chooseServer,
      changeServer,
      signIn,
      verify,
      signInInBrowser,
      signOut,
      updateUser,
      changePassword,
      cancel: onCancel,
    }),
    [
      state,
      pendingSignUp,
      register,
      confirmCode,
      resendVerification,
      retryPendingSignIn,
      forgetPendingSignUp,
      takePendingInvitation,
      chooseServer,
      changeServer,
      signIn,
      verify,
      signInInBrowser,
      signOut,
      updateUser,
      changePassword,
      onCancel,
    ],
  );

  return (
    <ApiProvider client={client}>
      <SessionContext.Provider value={api}>{children}</SessionContext.Provider>
    </ApiProvider>
  );
}

export function useSession(): SessionApi {
  const api = useContext(SessionContext);
  if (!api) throw new Error("useSession outside a session provider");
  return api;
}
