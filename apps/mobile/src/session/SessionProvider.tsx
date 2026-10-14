/**
 * The session, for every screen: where the app stands (`machine.ts`) and the actions that move it.
 *
 * Actions throw an {@link AuthFailure} whose `code` the screens turn into a sentence, so the wording
 * stays in the dictionaries and the logic stays here.
 */
import {
  apiErrorCode,
  changePassword as apiChangePassword,
  confirmEmailVerificationCode,
  exchangeNativeCode,
  getInstanceCapabilities,
  getSession,
  isApiError,
  login,
  logout,
  register as apiRegister,
  requestEmailVerification,
  verifyRecoveryCode,
  verifyTotp,
  type MfaMethod,
  type SessionUser,
} from "@ruchoir/client";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";

import { connectTo, setSessionToken } from "../api/instance";
import { canUseBrowserHandoff, signInThroughBrowser } from "../auth/browser";
import { clearDownloads } from "../files/cache";
import { sessionReducer, type SessionState } from "./machine";
import { normalizeServer } from "./server";
import { store } from "./store";

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

type SessionApi = {
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
  /** True when the Keychain held a session but the instance could not be reached to check it. */
  offlineAtBoot: boolean;
  retryBoot: () => void;
  chooseServer: (input: string) => Promise<void>;
  changeServer: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  verify: (method: "totp" | "recovery", code: string) => Promise<void>;
  /**
   * Sign in on the instance's own web page, for a second factor the app cannot run itself (a
   * passkey, `auth/browser.ts`). False when the person closed the page or declined.
   */
  signInInBrowser: () => Promise<boolean>;
  signOut: () => Promise<void>;
  /** The account changed from this app: shown at once on every screen. */
  updateUser: (patch: Partial<SessionUser>) => void;
  /**
   * Change the password. The server ends every session, this one included, so the app signs in again
   * with the new password (a second factor, when the account has one, is asked as at sign-in).
   */
  changePassword: (current: string, next: string) => Promise<void>;
};

const SessionContext = createContext<SessionApi | null>(null);

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

type Boot = { server: string | null; user: SessionUser | null; offline: boolean };

/**
 * What the Keychain remembers, checked against the instance: the account when the session is still
 * good, none when it is not (401) or there was none, `offline` when the instance did not answer.
 */
async function readStoredSession(onUnauthorized: (code?: string) => void): Promise<Boot> {
  const [server, token] = await Promise.all([store.getServer(), store.getToken()]);
  if (!server) return { server: null, user: null, offline: false };
  connectTo(server, onUnauthorized);
  setSessionToken(token);
  if (!token) return { server, user: null, offline: false };
  try {
    return { server, user: await getSession(), offline: false };
  } catch (err) {
    return isApiError(err, 401) ? { server, user: null, offline: false } : { server, user: null, offline: true };
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, { kind: "booting" });
  const [offlineAtBoot, setOfflineAtBoot] = useState(false);
  const hasToken = useRef(false);
  const pending = useRef<{ email: string; password: string } | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const invitation = useRef<string | null>(null);
  // The address last typed at sign-in, carried to the instance's page when it takes over.
  const lastEmail = useRef("");
  /** The instance the client talks to once a choice has been checked: where a failed one goes back. */
  const connected = useRef<string | null>(null);

  const holdToken = useCallback(async (token: string | null) => {
    hasToken.current = token !== null;
    setSessionToken(token);
    if (token) await store.setToken(token);
    else await store.clearToken();
  }, []);

  // A 401 anywhere means the session is gone (expired, or ended from another device), except a wrong
  // password typed to confirm an action (changing the password, turning off two-factor).
  const onUnauthorized = useCallback((code?: string) => {
    if (!hasToken.current || code === "invalid_credentials") return;
    void holdToken(null);
    clearDownloads();
    dispatch({ type: "unauthorized" });
  }, [holdToken]);

  // Reading the Keychain and checking the session happen outside React; their result is applied in
  // the callback, which is the one place the boot sets state.
  const applyBoot = useCallback((boot: Boot) => {
    connected.current = boot.server;
    if (boot.offline) return setOfflineAtBoot(true);
    hasToken.current = boot.user !== null;
    // A token the instance no longer honours is forgotten, not kept for the next launch.
    if (!boot.user) void holdToken(null);
    dispatch({ type: "restored", server: boot.server, user: boot.user });
  }, [holdToken]);

  useEffect(() => {
    let current = true;
    void readStoredSession(onUnauthorized).then((boot) => current && applyBoot(boot));
    return () => {
      current = false;
    };
  }, [applyBoot, onUnauthorized]);

  const retryBoot = useCallback(() => {
    setOfflineAtBoot(false);
    void readStoredSession(onUnauthorized).then(applyBoot);
  }, [applyBoot, onUnauthorized]);

  const chooseServer = useCallback(
    async (input: string) => {
      const check = normalizeServer(input);
      if (!check.ok) throw new AuthFailure(check.reason);
      connectTo(check.origin, onUnauthorized);
      // A server that is refused leaves the client where it was, so the screen and the requests
      // still name the same instance.
      const refuse = (code: FailureCode) => {
        if (connected.current) connectTo(connected.current, onUnauthorized);
        return new AuthFailure(code);
      };
      let caps;
      try {
        caps = await getInstanceCapabilities();
      } catch (err) {
        throw refuse(isApiError(err) ? "notRuchoir" : "unreachable");
      }
      // A web page answering 200 is not an instance: a Ruchoir always says whether it can send mail.
      if (typeof caps.emailDelivery !== "boolean") throw refuse("notRuchoir");
      if (!caps.nativeSessions) throw refuse("outdated");
      connected.current = check.origin;
      await store.setServer(check.origin);
      await holdToken(null);
      dispatch({ type: "serverChosen", server: check.origin });
    },
    [holdToken, onUnauthorized],
  );

  const forgetPendingSignUp = useCallback(() => {
    pending.current = null;
    setPendingEmail(null);
  }, []);

  const signedIn = useCallback(
    async (user: SessionUser, token: string | undefined) => {
      if (!token) throw new AuthFailure("outdated");
      await holdToken(token);
      forgetPendingSignUp();
      dispatch({ type: "authenticated", user });
    },
    [holdToken, forgetPendingSignUp],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      let result;
      lastEmail.current = email.trim();
      try {
        result = await login(email.trim(), password);
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
    [signedIn],
  );

  const register = useCallback(
    async ({ name, email, password, invitationToken }: SignUp) => {
      const address = email.trim();
      let result;
      try {
        result = await apiRegister(address, name.trim(), password, invitationToken);
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
    [signIn],
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
        await confirmEmailVerificationCode(waiting.email, code);
      } catch (err) {
        throw failureOf(err);
      }
      await signIn(waiting.email, waiting.password);
    },
    [signIn],
  );

  const resendVerification = useCallback(async () => {
    const waiting = pending.current;
    if (!waiting) return;
    try {
      await requestEmailVerification(waiting.email);
    } catch (err) {
      throw failureOf(err);
    }
  }, []);

  const takePendingInvitation = useCallback(() => {
    const token = invitation.current;
    invitation.current = null;
    return token;
  }, []);

  const verify = useCallback(
    async (method: "totp" | "recovery", code: string) => {
      if (state.kind !== "mfa") return;
      try {
        const done = await (method === "totp" ? verifyTotp : verifyRecoveryCode)(state.mfaToken, code.trim());
        await signedIn(done.user, done.sessionToken);
      } catch (err) {
        const failure = failureOf(err);
        // A spent or expired challenge cannot be retried: back to the password.
        if (failure.code === "invalid_token") dispatch({ type: "signedOut" });
        throw failure;
      }
    },
    [signedIn, state],
  );

  const signInInBrowser = useCallback(async () => {
    if (state.kind !== "mfa" && state.kind !== "signedOut") return false;
    const handed = await signInThroughBrowser(state.server, lastEmail.current || undefined);
    if (!handed) return false;
    let done;
    try {
      done = await exchangeNativeCode(handed.code, handed.verifier);
    } catch (err) {
      throw failureOf(err);
    }
    await signedIn(done.user, done.sessionToken);
    return true;
  }, [state, signedIn]);

  const signOut = useCallback(async () => {
    try {
      await logout();
    } catch {
      // Signing out works offline too: the token is forgotten here whatever the server heard.
    }
    await holdToken(null);
    clearDownloads();
    dispatch({ type: "signedOut" });
  }, [holdToken]);

  const updateUser = useCallback((patch: Partial<SessionUser>) => dispatch({ type: "userUpdated", patch }), []);

  const changePassword = useCallback(
    async (current: string, next: string) => {
      if (state.kind !== "signedIn") return;
      const email = state.user.email;
      try {
        await apiChangePassword(current, next);
      } catch (err) {
        throw failureOf(err);
      }
      // The old token is dead: forget it before anything answers 401 with it.
      await holdToken(null);
      try {
        await signIn(email, next);
      } catch {
        clearDownloads();
        dispatch({ type: "signedOut" });
      }
    },
    [state, holdToken, signIn],
  );

  const changeServer = useCallback(() => {
    void holdToken(null);
    dispatch({ type: "changeServer" });
  }, [holdToken]);

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
      offlineAtBoot,
      retryBoot,
      chooseServer,
      changeServer,
      signIn,
      verify,
      signInInBrowser,
      signOut,
      updateUser,
      changePassword,
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
      offlineAtBoot,
      retryBoot,
      chooseServer,
      changeServer,
      signIn,
      verify,
      signInInBrowser,
      signOut,
      updateUser,
      changePassword,
    ],
  );

  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const api = useContext(SessionContext);
  if (!api) throw new Error("useSession outside SessionProvider");
  return api;
}
