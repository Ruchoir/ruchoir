/**
 * Keeps the account settings of this browser (`accountPrefs.ts`) in line with the server's.
 *
 * - At sign-in, and again whenever the connection comes back (what was announced meanwhile is
 *   lost): read the account's (`reconcileAccountPrefs`). The first time this browser syncs with the
 *   account, the two are merged (nobody's arrangement is lost); afterwards the server's win, so a
 *   change made on another device while this one was closed is what it shows.
 * - A change made here: applied at once (the provider already did), queued, sent. The queue lives
 *   in `localStorage`, so a change made offline, or in a tab closed before it was sent, goes up at
 *   the next connection rather than being lost. One send at a time.
 * - A change made elsewhere (`preferences.updated`): the document is read again rather than the
 *   event's values taken, so two changes announced out of order still end on the server's state. A
 *   key this browser still has to send wins over it, being the newer choice. The desktop app passes
 *   it on to its other instances.
 * - A server from before account preferences (404): everything stays in this browser, as before.
 */
import { useEffect, useRef } from "react";
import { ApiError, mergePending, reconcileAccountPrefs, type AccountPrefsDoc } from "@ruchoir/client";

import { getAccountPreferences, patchAccountPreferences, setDmHidden } from "@/lib/data/api";
import type { DesktopBridge } from "@/features/desktop/DesktopContext";
import { fromWire, toWire, WEB_ACCOUNT_KEYS } from "./accountPrefs";
import { DEFAULTS, clearLegacyHiddenDms, onAccountChange, peekLegacyHiddenDms, useSettings } from "./settings";

const PENDING_KEY = "ruchoir.pendingAccountPrefs";
/** The accounts this browser already synced with once, by user id (`first` below). */
const SYNCED_KEY = "ruchoir.accountSynced";

function readJson<T>(key: string, fallback: T, valid: (value: unknown) => boolean): T {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null");
    return valid(raw) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown, empty: boolean) {
  try {
    if (empty) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage failures: the change is still applied here
  }
}

const isDoc = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
const readPending = (): AccountPrefsDoc => readJson<AccountPrefsDoc>(PENDING_KEY, {}, isDoc);
const writePending = (doc: AccountPrefsDoc) => writeJson(PENDING_KEY, doc, Object.keys(doc).length === 0);
const syncedWith = (userId: string) => readJson<string[]>(SYNCED_KEY, [], Array.isArray).includes(userId);
const markSynced = (userId: string) => {
  const all = readJson<string[]>(SYNCED_KEY, [], Array.isArray);
  if (!all.includes(userId)) writeJson(SYNCED_KEY, [...all, userId], false);
};

function without(doc: AccountPrefsDoc, keys: Iterable<string>): AccountPrefsDoc {
  const out = { ...doc };
  for (const key of keys) delete out[key];
  return out;
}

/** The server's values for `keys`, `null` for one it does not hold (back to its default). */
function valuesOf(server: AccountPrefsDoc, keys: Iterable<string>): AccountPrefsDoc {
  const out: AccountPrefsDoc = {};
  for (const key of keys) out[key] = key in server ? server[key] : null;
  return out;
}

type SyncState = { session: string; state: "idle" | "syncing" | "ready" | "unsupported"; sending: boolean };

/**
 * Wire it once, in the signed-in shell. `userId` is empty while signed out. Returns what the
 * real-time handlers call: `remote` for `preferences.updated`, `resync` when the connection is back.
 */
export function useAccountPrefsSync(userId: string, desktop: DesktopBridge | null, unread: (dmId: string) => boolean = () => false) {
  const settings = useSettings();
  const settingsRef = useRef(settings);
  const desktopRef = useRef(desktop);
  const unreadRef = useRef(unread);
  useEffect(() => {
    settingsRef.current = settings;
    desktopRef.current = desktop;
    unreadRef.current = unread;
  });
  const sync = useRef<SyncState>({ session: "", state: "idle", sending: false });

  const api = useRef({
    /** Apply what the server says, minus what this browser has yet to send. */
    adoptFrom(doc: AccountPrefsDoc) {
      const fresh = without(doc, Object.keys(readPending()));
      const s = settingsRef.current;
      s.adopt(fromWire(fresh, s, DEFAULTS));
    },

    async start(session: string) {
      sync.current = { session, state: "syncing", sending: false };
      let server: AccountPrefsDoc | null;
      try {
        server = await getAccountPreferences();
      } catch {
        // Unreachable for now: retried when the connection comes back.
        if (sync.current.session === session) sync.current.state = "idle";
        return;
      }
      if (sync.current.session !== session) return;
      if (server === null) {
        sync.current.state = "unsupported";
        return;
      }
      const { apply, push } = reconcileAccountPrefs({
        local: toWire(settingsRef.current),
        server,
        keys: WEB_ACCOUNT_KEYS,
        defaults: toWire(DEFAULTS),
        first: !syncedWith(session),
      });
      api.current.adoptFrom(apply);
      writePending(mergePending(push, readPending()));
      markSynced(session);
      sync.current.state = "ready";
      void api.current.handOverHidden();
      await api.current.flush();
    },

    /**
     * Conversations this browser hid before the server kept them: sent up, forgotten once taken.
     * One with something unread is left out: the older page brought those back.
     */
    async handOverHidden() {
      const ids = peekLegacyHiddenDms().filter((id) => !unreadRef.current(id));
      if (ids.length === 0) return;
      const done = await Promise.all(ids.map((id) => setDmHidden(id, true).then(() => true, (err) => err instanceof ApiError && err.status === 404)));
      if (done.every(Boolean)) clearLegacyHiddenDms();
    },

    /** Send what is queued, one send at a time, if the account is reachable. */
    async flush() {
      const current = sync.current;
      if (current.state !== "ready" || current.sending) return;
      const sent = readPending();
      if (Object.keys(sent).length === 0) return;
      current.sending = true;
      try {
        await patchAccountPreferences(sent);
        api.current.sent(sent);
      } catch (err) {
        // Refused: one key the server does not take must not cost the others. Each goes alone, and
        // a refused one takes the server's value back (the screen must not keep what it did not).
        if (err instanceof ApiError && err.status === 400) await api.current.oneByOne(sent);
        // Otherwise unreachable: kept, sent when the connection comes back.
      } finally {
        current.sending = false;
      }
      if (Object.keys(readPending()).length > 0 && current === sync.current) void api.current.flush();
    },

    async oneByOne(sent: AccountPrefsDoc) {
      const refused: string[] = [];
      for (const [key, value] of Object.entries(sent)) {
        try {
          await patchAccountPreferences({ [key]: value });
          api.current.sent({ [key]: value });
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 400)) return;
          refused.push(key);
        }
      }
      if (refused.length === 0) return;
      writePending(without(readPending(), refused));
      const server = await getAccountPreferences().catch(() => null);
      if (server) api.current.adoptFrom(valuesOf(server, refused));
    },

    /** What the server took leaves the queue; a key changed again meanwhile stays to go up next. */
    sent(doc: AccountPrefsDoc) {
      const left = readPending();
      for (const [key, value] of Object.entries(doc)) {
        if (JSON.stringify(left[key]) === JSON.stringify(value)) delete left[key];
      }
      writePending(left);
      desktopRef.current?.accountPreferencesSaved(doc);
    },

    /** A change made on another device: read the account again, take what it says of those keys. */
    async remote(changes: AccountPrefsDoc) {
      if (sync.current.state !== "ready") return;
      const server = await getAccountPreferences().catch(() => null);
      if (!server) return;
      const back = valuesOf(server, Object.keys(changes));
      api.current.adoptFrom(back);
      // The desktop app's other instances hear it too, so they do not keep the old value.
      desktopRef.current?.accountPreferencesSaved(without(back, Object.keys(readPending())));
    },

    /** The connection is back: what was announced meanwhile is lost, so read the account again. */
    resync() {
      const session = sync.current.session;
      if (!session || sync.current.state === "unsupported" || sync.current.state === "syncing") return;
      void api.current.start(session);
    },
  });

  // Sign-in (or another account): reconcile once.
  useEffect(() => {
    if (!userId || sync.current.session === userId) return;
    void api.current.start(userId);
  }, [userId]);

  // Every account change made here.
  useEffect(
    () =>
      onAccountChange((patch) => {
        if (sync.current.state === "unsupported") return;
        writePending(mergePending(readPending(), patch));
        void api.current.flush();
      }),
    [],
  );

  return {
    remote: (changes: AccountPrefsDoc) => void api.current.remote(changes),
    resync: () => api.current.resync(),
  };
}
