/**
 * The instances this phone is signed in to, and the one on screen (ADR 0007).
 *
 * Each instance has its own client (`createClient`), holding its address and, through `tokens`, its
 * session token: two instances never share one, and a request started on one finishes there. The
 * accounts boot from the Keychain (`store.ts`), check each session with its instance, and keep a
 * status per instance: signed in (with the account), signed out (its session ended), or offline (not
 * checked yet). The sign-in flow runs when there is nothing signed in, or when the person adds an
 * instance or renews one.
 *
 * What every instance shows outside its own screens (its spaces with their unread counts, its unread
 * notifications) is published here by its scope (`InstanceScope`) as a summary, which the space sheet,
 * the bell and the badges read.
 */
import { isApiError, type RuchoirClient, type SessionUser, type Workspace } from "@ruchoir/client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";

import { clearDownloads } from "../files/cache";
import { notifications } from "../push/native";
import { forgetPhoneOn, refreshPhonePush, shareSessions } from "../push/phone";
import { refreshWidgets } from "../widgets";
import { InstanceClients } from "./clients";
import { invitationRoute } from "./invitation";
import { unreadEverywhere } from "./summary";
import { addInstance, findByOrigin, removeInstance, setActive, setLastSpace, type InstanceEntry, type Registry } from "./registry";
import { loadRegistry, newInstanceId, saveRegistry, tokens } from "./store";

export type InstanceStatus =
  | { kind: "checking" }
  | { kind: "signedIn"; user: SessionUser }
  | { kind: "signedOut"; reason?: "expired" | "locked" }
  | { kind: "offline" };

export type Account = InstanceEntry & { client: RuchoirClient; status: InstanceStatus };

/** What an instance shows outside its own screens. */
export type Summary = { spaces: Workspace[]; unreadNotifications: number };

/**
 * Why the sign-in flow is on screen. An invitation to a space of another instance can start it at
 * that instance's address, and is accepted once signed in (`openInvitation`).
 */
export type Flow = { kind: "add"; server?: string; invitation?: string } | { kind: "renew"; id: string; invitation?: string };

type AccountsApi = {
  booted: boolean;
  accounts: Account[];
  /** The instance whose interface is on screen: a signed-in one, or none. */
  active: Account | null;
  summaries: Record<string, Summary>;
  publishSummary: (id: string, summary: Summary) => void;
  lastSpace: (id: string) => string | undefined;
  rememberSpace: (id: string, spaceId: string) => void;
  /** Show another instance, at one of its spaces when given. */
  switchTo: (id: string, spaceId?: string) => void;
  flow: Flow | null;
  startAdd: () => void;
  renew: (id: string) => void;
  cancelFlow: () => void;
  isSignedIn: (origin: string) => boolean;
  /** A session obtained by the flow: the instance is added (or renewed) and shown. */
  completeSignIn: (done: { origin: string; token: string; user: SessionUser; invitation: string | null }) => Promise<void>;
  /** The invitation pasted at sign-up on this instance, handed once. */
  takeInvitation: (id: string) => string | null;
  /**
   * Join a space of another instance: shown at once when the phone is signed in there (the space
   * gate accepts the invitation), else after signing in there again or adding it.
   */
  openInvitation: (origin: string, token: string) => void;
  /** Sign out of one instance: it forgets this phone, the token goes, its downloads too. */
  signOutOf: (id: string, reason?: "locked") => Promise<void>;
  /** The app lock's last resort (a forgotten PIN): out of every instance. */
  signOutEverywhere: (reason: "locked") => Promise<void>;
  /** Forget an instance altogether (signing out of it first). */
  remove: (id: string) => Promise<void>;
  updateUser: (id: string, patch: Partial<SessionUser>) => void;
  /** Replace an instance's token (a new password signs every session out, then in again). */
  holdToken: (id: string, token: string | null) => Promise<void>;
  /** Check again the instances that could not be reached. */
  retryOffline: () => void;
};

const AccountsContext = createContext<AccountsApi | null>(null);

export function AccountsProvider({ children }: { children: ReactNode }) {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [statuses, setStatuses] = useState<Record<string, InstanceStatus>>({});
  const [summaries, setSummaries] = useState<Record<string, Summary>>({});
  const [flow, setFlow] = useState<Flow | null>(null);
  // One client per instance and the tokens they present, for the life of the app (`clients.ts`).
  const [live] = useState(() => new InstanceClients());
  const invitations = useRef(new Map<string, string>());
  const registryRef = useRef<Registry | null>(null);

  const update = useCallback((change: (r: Registry) => Registry) => {
    setRegistry((current) => {
      if (!current) return current;
      const next = change(current);
      if (next !== current) {
        registryRef.current = next;
        void saveRegistry(next).catch(() => {});
      }
      return next;
    });
  }, []);

  const setStatus = useCallback((id: string, status: InstanceStatus) => setStatuses((all) => ({ ...all, [id]: status })), []);

  const clientOf = useCallback((entry: InstanceEntry): RuchoirClient => live.client(entry), [live]);

  /** Ask an instance who is signed in with the token the phone holds for it. */
  const check = useCallback(
    async (entry: InstanceEntry) => {
      const token = live.token(entry.id);
      if (!token) return setStatus(entry.id, { kind: "signedOut" });
      try {
        setStatus(entry.id, { kind: "signedIn", user: await clientOf(entry).getSession() });
      } catch (err) {
        if (isApiError(err, 401)) {
          // A token the instance no longer honours is forgotten, not kept for the next launch.
          live.hold(entry.id, null);
          void tokens.clear(entry.id).catch(() => {});
          setStatus(entry.id, { kind: "signedOut" });
        } else setStatus(entry.id, { kind: "offline" });
      }
    },
    [clientOf, live, setStatus],
  );

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const loaded = await loadRegistry().catch(() => null);
      const start = loaded ?? { instances: [], active: null, lastSpace: {} };
      await Promise.all(start.instances.map(async (entry) => live.hold(entry.id, await tokens.get(entry.id).catch(() => null))));
      if (!mounted) return;
      registryRef.current = start;
      setRegistry(start);
      await Promise.all(start.instances.map(check));
    })();
    return () => {
      mounted = false;
    };
  }, [check, live]);

  const forget = useCallback(async (id: string) => {
    live.hold(id, null);
    await tokens.clear(id).catch(() => {});
  }, [live]);

  // A 401 on an instance ends its session there, except a wrong password typed to confirm an action
  // (changing the password, turning off two-factor).
  useEffect(() => {
    live.onUnauthorized((id, code) => {
      if (!live.token(id) || code === "invalid_credentials") return;
      const entry = registryRef.current?.instances.find((e) => e.id === id);
      void forget(id);
      if (entry) clearDownloads(entry.origin);
      setStatus(id, { kind: "signedOut", reason: "expired" });
    });
  }, [live, forget, setStatus]);

  const accounts = useMemo<Account[]>(
    () =>
      (registry?.instances ?? []).map((entry) => ({
        ...entry,
        client: clientOf(entry),
        status: statuses[entry.id] ?? { kind: "checking" },
      })),
    [registry, statuses, clientOf],
  );
  const signedIn = useMemo(() => accounts.filter((a) => a.status.kind === "signedIn"), [accounts]);
  const active = signedIn.find((a) => a.id === registry?.active) ?? signedIn[0] ?? null;

  // The phone registers for notifications with every signed-in instance. Done whenever that set changes.
  const signedInKey = signedIn.map((a) => a.id).join(" ");
  useEffect(() => {
    if (!registry) return;
    void refreshPhonePush(signedIn.map((a) => a.client));
    // Only the set of signed-in instances matters here, not their accounts' details.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedInKey, registry !== null]);

  // The extensions (notifications, widgets) read every instance still holding a session and its
  // token. Left alone while a session is being checked: an app opened from a widget would otherwise
  // hand over no instance at all for the moment of the check, and the home screen would say "sign in"
  // until it is over. An instance out of reach keeps its place; only a session that ended leaves.
  const checking = accounts.some((a) => a.status.kind === "checking");
  const held = accounts.filter((a) => a.status.kind === "signedIn" || a.status.kind === "offline");
  const heldKey = held.map((a) => a.id).join(" ");
  useEffect(() => {
    if (!registry || checking) return;
    const shared = held.flatMap((a) => {
      const token = live.token(a.id);
      return token ? [{ server: a.origin, token }] : [];
    });
    void shareSessions(shared)
      .then(refreshWidgets)
      .catch(() => {});
    // Only the set of instances holding a session matters here, not their accounts' details.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldKey, checking, registry !== null]);

  // The app's icon carries the unread notifications of every signed-in instance, as the bell does;
  // the extensions keep it current while the app is closed (`push/background.ts`, `targets/`).
  const unreadTotal = registry ? unreadEverywhere(summaries, signedIn.map((a) => a.id)) : null;
  useEffect(() => {
    if (unreadTotal === null) return;
    void notifications()?.setBadgeCountAsync(unreadTotal).catch(() => {});
  }, [unreadTotal]);

  // Back in front: an instance that could not be reached is tried again.
  const retryOffline = useCallback(() => {
    for (const entry of registryRef.current?.instances ?? []) {
      if (statuses[entry.id]?.kind === "offline") {
        setStatus(entry.id, { kind: "checking" });
        void check(entry);
      }
    }
  }, [statuses, check, setStatus]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => state === "active" && retryOffline());
    return () => subscription.remove();
  }, [retryOffline]);

  const publishSummary = useCallback((id: string, summary: Summary) => setSummaries((all) => ({ ...all, [id]: summary })), []);
  const lastSpace = useCallback((id: string) => registry?.lastSpace[id], [registry]);
  const rememberSpace = useCallback((id: string, spaceId: string) => update((r) => (r.lastSpace[id] === spaceId ? r : setLastSpace(r, id, spaceId))), [update]);
  const switchTo = useCallback(
    (id: string, spaceId?: string) => update((r) => (spaceId ? setLastSpace(setActive(r, id), id, spaceId) : setActive(r, id))),
    [update],
  );

  const isSignedIn = useCallback(
    (origin: string) => {
      const entry = registryRef.current ? findByOrigin(registryRef.current, origin) : undefined;
      if (!entry) return false;
      // Renewing that very instance is not adding it twice.
      if (flow?.kind === "renew" && flow.id === entry.id) return false;
      return statuses[entry.id]?.kind === "signedIn";
    },
    [statuses, flow],
  );

  const completeSignIn = useCallback(
    async ({ origin, token, user, invitation }: { origin: string; token: string; user: SessionUser; invitation: string | null }) => {
      const current = registryRef.current;
      if (!current) return;
      const entry = findByOrigin(current, origin) ?? { id: newInstanceId(), origin };
      await tokens.set(entry.id, token);
      live.hold(entry.id, token);
      if (invitation) invitations.current.set(entry.id, invitation);
      clientOf(entry);
      const next = addInstance(current, entry);
      registryRef.current = next;
      setRegistry(next);
      await saveRegistry(next).catch(() => {});
      setStatus(entry.id, { kind: "signedIn", user });
      setFlow(null);
    },
    [clientOf, live, setStatus],
  );

  const takeInvitation = useCallback((id: string) => {
    const token = invitations.current.get(id) ?? null;
    invitations.current.delete(id);
    return token;
  }, []);

  const openInvitation = useCallback(
    (origin: string, token: string) => {
      const route = invitationRoute(accounts, origin);
      if (route.kind === "switch") {
        invitations.current.set(route.id, token);
        update((r) => setActive(r, route.id));
      } else if (route.kind === "renew") setFlow({ kind: "renew", id: route.id, invitation: token });
      else setFlow({ kind: "add", server: origin, invitation: token });
    },
    [accounts, update],
  );

  const signOutOf = useCallback(
    async (id: string, reason?: "locked") => {
      const entry = registryRef.current?.instances.find((e) => e.id === id);
      if (!entry) return;
      const client = clientOf(entry);
      // While the session still opens the door: the instance forgets this phone (ADR 0006).
      await forgetPhoneOn(client);
      try {
        await client.logout();
      } catch {
        // Signing out works offline too: the token is forgotten here whatever the server heard.
      }
      await forget(id);
      clearDownloads(entry.origin);
      setStatus(id, { kind: "signedOut", reason });
    },
    [clientOf, forget, setStatus],
  );

  const signOutEverywhere = useCallback(
    async (reason: "locked") => {
      const ids = (registryRef.current?.instances ?? []).map((e) => e.id);
      await Promise.all(ids.map((id) => signOutOf(id, reason)));
    },
    [signOutOf],
  );

  const remove = useCallback(
    async (id: string) => {
      if (live.token(id)) await signOutOf(id);
      live.drop(id);
      setSummaries(({ [id]: _gone, ...rest }) => rest);
      update((r) => removeInstance(r, id));
    },
    [live, signOutOf, update],
  );

  const updateUser = useCallback((id: string, patch: Partial<SessionUser>) => {
    setStatuses((all) => {
      const status = all[id];
      return status?.kind === "signedIn" ? { ...all, [id]: { kind: "signedIn", user: { ...status.user, ...patch } } } : all;
    });
  }, []);

  const holdToken = useCallback(async (id: string, token: string | null) => {
    live.hold(id, token);
    if (token) await tokens.set(id, token);
    else await tokens.clear(id);
  }, [live]);

  const startAdd = useCallback(() => setFlow({ kind: "add" }), []);
  const renew = useCallback((id: string) => setFlow({ kind: "renew", id }), []);
  const cancelFlow = useCallback(() => setFlow(null), []);

  const api = useMemo<AccountsApi>(
    () => ({
      booted: registry !== null && accounts.every((a) => a.status.kind !== "checking"),
      accounts,
      active,
      summaries,
      publishSummary,
      lastSpace,
      rememberSpace,
      switchTo,
      flow,
      startAdd,
      renew,
      cancelFlow,
      isSignedIn,
      completeSignIn,
      takeInvitation,
      openInvitation,
      signOutOf,
      signOutEverywhere,
      remove,
      updateUser,
      holdToken,
      retryOffline,
    }),
    [
      registry,
      accounts,
      active,
      summaries,
      publishSummary,
      lastSpace,
      rememberSpace,
      switchTo,
      flow,
      startAdd,
      renew,
      cancelFlow,
      isSignedIn,
      completeSignIn,
      takeInvitation,
      openInvitation,
      signOutOf,
      signOutEverywhere,
      remove,
      updateUser,
      holdToken,
      retryOffline,
    ],
  );
  return <AccountsContext.Provider value={api}>{children}</AccountsContext.Provider>;
}

/** The clients of every signed-in instance: what turning the phone's notifications on or off reaches. */
export function useSignedInClients(): RuchoirClient[] {
  const { accounts } = useAccounts();
  return useMemo(() => accounts.filter((a) => a.status.kind === "signedIn").map((a) => a.client), [accounts]);
}

export function useAccounts(): AccountsApi {
  const api = useContext(AccountsContext);
  if (!api) throw new Error("useAccounts outside AccountsProvider");
  return api;
}
