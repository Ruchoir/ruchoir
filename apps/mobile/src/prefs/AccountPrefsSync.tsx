/**
 * The account preferences kept in line with the server's (`store.ts`).
 *
 * - `AccountPrefsSync`, in every instance's scope: reconciles once that instance is signed in, and
 *   adopts the changes it announces (`preferences.updated`).
 * - `AccountPrefsSender`, once for the app: what a change made here is sent through, every
 *   signed-in instance at once (as the phone's notification switch is). A change made offline goes
 *   up when the list of instances changes, at the next sign-in, or with the next change.
 */
import { useEffect } from "react";

import { useSignedInClients } from "../accounts/AccountsProvider";
import { useApi } from "../api/useApi";
import { useRealtimeEvent } from "../realtime/RealtimeProvider";
import { adoptPrefs, flushAccountPrefs, reconcileWith, setAccountSender } from "./store";

export function AccountPrefsSync() {
  const api = useApi();
  useEffect(() => {
    void reconcileWith(api).then(() => flushAccountPrefs());
  }, [api]);
  useRealtimeEvent((event) => {
    if (event.type === "preferences") adoptPrefs(event.changes);
  });
  return null;
}

export function AccountPrefsSender() {
  const clients = useSignedInClients();
  useEffect(() => {
    if (clients.length === 0) return;
    setAccountSender(async (patch) => {
      const sent = await Promise.all(
        clients.map((client) =>
          client.patchAccountPreferences(patch).then(
            () => true,
            // An instance from before account preferences answers 404: nothing to keep there.
            (err: { status?: number }) => err?.status === 404,
          ),
        ),
      );
      return sent.every(Boolean);
    });
    return () => setAccountSender(null);
  }, [clients]);
  return null;
}
