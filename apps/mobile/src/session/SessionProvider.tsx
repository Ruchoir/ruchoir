/**
 * The session, for every screen: where the app stands (`machine.ts`) and the actions that move it.
 *
 * Actions throw an {@link AuthFailure} whose `code` the screens turn into a sentence, so the wording
 * stays in the dictionaries and the logic stays here.
 */
import {
  apiErrorCode,
  getInstanceCapabilities,
  getSession,
  isApiError,
  login,
  logout,
  verifyRecoveryCode,
  verifyTotp,
  type MfaMethod,
  type SessionUser,
} from "@ruchoir/client";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";

import { connectTo, setSessionToken } from "../api/instance";
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
  | "passkeyOnly"
  | "unknown";

export class AuthFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
  }
}

/** The second factors this app can complete. A passkey needs a native build (step 6). */
const APP_METHODS: MfaMethod[] = ["totp", "recovery"];

type SessionApi = {
  state: SessionState;
  /** True when the Keychain held a session but the instance could not be reached to check it. */
  offlineAtBoot: boolean;
  retryBoot: () => void;
  chooseServer: (input: string) => Promise<void>;
  changeServer: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  verify: (method: "totp" | "recovery", code: string) => Promise<void>;
  signOut: () => Promise<void>;
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
  ];
  if (code && (known as string[]).includes(code)) return new AuthFailure(code as FailureCode);
  return new AuthFailure(isApiError(err) ? "unknown" : "unreachable");
}

type Boot = { server: string | null; user: SessionUser | null; offline: boolean };

/**
 * What the Keychain remembers, checked against the instance: the account when the session is still
 * good, none when it is not (401) or there was none, `offline` when the instance did not answer.
 */
async function readStoredSession(onUnauthorized: () => void): Promise<Boot> {
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

  const holdToken = useCallback(async (token: string | null) => {
    hasToken.current = token !== null;
    setSessionToken(token);
    if (token) await store.setToken(token);
    else await store.clearToken();
  }, []);

  // A 401 anywhere means the session is gone (expired, or ended from another device).
  const onUnauthorized = useCallback(() => {
    if (!hasToken.current) return;
    void holdToken(null);
    clearDownloads();
    dispatch({ type: "unauthorized" });
  }, [holdToken]);

  // Reading the Keychain and checking the session happen outside React; their result is applied in
  // the callback, which is the one place the boot sets state.
  const applyBoot = useCallback((boot: Boot) => {
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
      let caps;
      try {
        caps = await getInstanceCapabilities();
      } catch (err) {
        throw new AuthFailure(isApiError(err) ? "notRuchoir" : "unreachable");
      }
      // A web page answering 200 is not an instance: a Ruchoir always says whether it can send mail.
      if (typeof caps.emailDelivery !== "boolean") throw new AuthFailure("notRuchoir");
      if (!caps.nativeSessions) throw new AuthFailure("outdated");
      await store.setServer(check.origin);
      await holdToken(null);
      dispatch({ type: "serverChosen", server: check.origin });
    },
    [holdToken, onUnauthorized],
  );

  const signedIn = useCallback(
    async (user: SessionUser, token: string | undefined) => {
      if (!token) throw new AuthFailure("outdated");
      await holdToken(token);
      dispatch({ type: "authenticated", user });
    },
    [holdToken],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      let result;
      try {
        result = await login(email.trim(), password);
      } catch (err) {
        throw failureOf(err);
      }
      if (result.kind === "authenticated") return signedIn(result.user, result.sessionToken);
      const methods = result.methods.filter((m) => APP_METHODS.includes(m));
      if (methods.length === 0) throw new AuthFailure("passkeyOnly");
      dispatch({ type: "mfaRequired", mfaToken: result.mfaToken, methods });
    },
    [signedIn],
  );

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

  const changeServer = useCallback(() => {
    void holdToken(null);
    dispatch({ type: "changeServer" });
  }, [holdToken]);

  const api = useMemo<SessionApi>(
    () => ({
      state,
      offlineAtBoot,
      retryBoot,
      chooseServer,
      changeServer,
      signIn,
      verify,
      signOut,
    }),
    [state, offlineAtBoot, retryBoot, chooseServer, changeServer, signIn, verify, signOut],
  );

  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const api = useContext(SessionContext);
  if (!api) throw new Error("useSession outside SessionProvider");
  return api;
}
