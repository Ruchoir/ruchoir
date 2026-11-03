/**
 * Keeps the account settings of this browser (`accountPrefs.ts`) in line with the server's.
 *
 * - At sign-in: read the account's; the first device sends its own up, otherwise the server's win
 *   (`reconcileAccountPrefs`). In the desktop app, once the first instance's are adopted, the app's
 *   are the person's and go to every instance, like the notification settings.
 * - A change made here: applied at once (the provider already did), queued, sent. The queue lives
 *   in `localStorage`, so a change made offline, or in a tab closed before it was sent, goes up at
 *   the next connection rather than being lost.
 * - A change made elsewhere (`preferences.updated`): applied here without being sent back. A key
 *   this browser still has to send wins over it, being the newer choice.
 * - A server from before account preferences (404): everything stays in this browser, as before.
 */
import { useEffect, useRef } from "react";
import { ApiError, mergePending, reconcileAccountPrefs, type AccountPrefsDoc } from "@ruchoir/client";

import { getAccountPreferences, patchAccountPreferences, setDmHidden } from "@/lib/data/api";
import { isDesktop } from "@/lib/desktop/runtime";
import type { DesktopBridge } from "@/features/desktop/DesktopContext";
import { fromWire, toWire, WEB_ACCOUNT_KEYS } from "./accountPrefs";
import { DEFAULTS, onAccountChange, takeLegacyHiddenDms, useSettings } from "./settings";

const PENDING_KEY = "ruchoir.pendingAccountPrefs";

function readPending(): AccountPrefsDoc {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writePending(doc: AccountPrefsDoc) {
  try {
    if (Object.keys(doc).length === 0) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(doc));
  } catch {
    // ignore storage failures: the change is still applied here
  }
}

function without(doc: AccountPrefsDoc, keys: Iterable<string>): AccountPrefsDoc {
  const out = { ...doc };
  for (const key of keys) delete out[key];
  return out;
}

type SyncState = { session: string; state: "idle" | "syncing" | "ready" | "unsupported"; sending: boolean };

/**
 * Wire it once, in the signed-in shell. `sessionId` is empty while signed out. Returns what the
 * real-time handlers call: `remote` for `preferences.updated`, `flush` when the connection is back.
 */
export function useAccountPrefsSync(sessionId: string, desktop: DesktopBridge | null) {
  const settings = useSettings();
  const settingsRef = useRef(settings);
  const desktopRef = useRef(desktop);
  useEffect(() => {
    settingsRef.current = settings;
    desktopRef.current = desktop;
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
        // Unreachable for now: retried when the connection comes back (`flush`).
        if (sync.current.session === session) sync.current.state = "idle";
        return;
      }
      if (sync.current.session !== session) return;
      if (server === null) {
        sync.current.state = "unsupported";
        return;
      }
      const s = settingsRef.current;
      const shared = isDesktop && s.accountShared;
      const { apply, push } = reconcileAccountPrefs({ local: toWire(s), server, keys: WEB_ACCOUNT_KEYS, shared });
      api.current.adoptFrom(apply);
      if (isDesktop && !s.accountShared) s.adopt({ accountShared: true });
      writePending(mergePending(push, readPending()));
      // Conversations this browser hid before the server kept them: sent up once.
      for (const id of takeLegacyHiddenDms()) void setDmHidden(id, true).catch(() => {});
      sync.current.state = "ready";
      await api.current.flush();
    },

    /** Send what is queued, if the account is reachable. */
    async flush() {
      const current = sync.current;
      if (current.state === "idle" && current.session) return api.current.start(current.session);
      if (current.state !== "ready" || current.sending) return;
      const sent = readPending();
      if (Object.keys(sent).length === 0) return;
      current.sending = true;
      try {
        await patchAccountPreferences(sent);
        // Only what was sent leaves the queue: a key changed again meanwhile stays to go up next.
        const left = readPending();
        for (const [key, value] of Object.entries(sent)) {
          if (JSON.stringify(left[key]) === JSON.stringify(value)) delete left[key];
        }
        writePending(left);
        desktopRef.current?.accountPreferencesSaved(sent);
      } catch (err) {
        if (err instanceof ApiError && err.status === 400) {
          // Refused: the screen must not keep what the server did not. Take its values back.
          writePending(without(readPending(), Object.keys(sent)));
          const server = await getAccountPreferences().catch(() => null);
          if (server) {
            const back: AccountPrefsDoc = {};
            for (const key of Object.keys(sent)) back[key] = key in server ? server[key] : null;
            api.current.adoptFrom(back);
          }
        }
        // Otherwise unreachable: kept, sent when the connection comes back.
      } finally {
        current.sending = false;
      }
      if (Object.keys(readPending()).length > 0) void api.current.flush();
    },

    /** A change made on another device. */
    remote(changes: AccountPrefsDoc) {
      if (sync.current.state !== "ready") return;
      api.current.adoptFrom(changes);
    },
  });

  // Sign-in (or a new session): reconcile once.
  useEffect(() => {
    if (!sessionId || sync.current.session === sessionId) return;
    void api.current.start(sessionId);
  }, [sessionId]);

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

  return { remote: (changes: AccountPrefsDoc) => api.current.remote(changes), flush: () => void api.current.flush() };
}
