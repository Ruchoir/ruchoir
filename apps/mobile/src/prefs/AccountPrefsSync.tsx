/**
 * The account preferences kept in line with the server's (`store.ts`).
 *
 * - `AccountPrefsSync`, in every instance's scope: reads the account once that instance is signed
 *   in and again whenever its connection comes back (what was announced meanwhile is lost), and
 *   adopts the changes it announces (`preferences.updated`).
 * - `AccountPrefsSender`, once for the app: what a change is sent through, to every signed-in
 *   instance at once (as the phone's notification switch is). A change made offline goes up when
 *   an instance is read again, or with the next change.
 */
import { useEffect } from "react";

import { useSignedInClients } from "../accounts/AccountsProvider";
import { useApi } from "../api/useApi";
import { useRealtimeEvent, useResync } from "../realtime/RealtimeProvider";
import { adoptRemote, reconcileWith, setAccountSender } from "./store";

export function AccountPrefsSync({ userId }: { userId: string }) {
  const api = useApi();
  const revision = useResync();
  useEffect(() => {
    void reconcileWith(api, userId);
  }, [api, userId, revision]);
  useRealtimeEvent((event) => {
    if (event.type === "preferences") void adoptRemote(api, event.changes);
  });
  return null;
}

export function AccountPrefsSender() {
  const clients = useSignedInClients();
  useEffect(() => {
    if (clients.length === 0) return;
    setAccountSender(async (patch, except) => {
      const sent = await Promise.all(
        clients
          .filter((client) => client !== except)
          .map((client) =>
            client.patchAccountPreferences(patch).then(
              () => true,
              // 404: an instance from before account preferences, nothing to keep there. 400: a
              // value it refuses for good; the next reading of that account brings its own back.
              (err: { status?: number }) => err?.status === 404 || err?.status === 400,
            ),
          ),
      );
      return sent.every(Boolean);
    });
    return () => setAccountSender(null);
  }, [clients]);
  return null;
}
