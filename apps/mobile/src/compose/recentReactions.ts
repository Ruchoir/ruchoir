/**
 * The emoji the person reacted with last, which the quick reactions lead with (`recent_reactions`,
 * kept by the instance, so the web, the desktop and this phone show the same). One list per instance
 * and account, read on first use from an instance that has the feature; each new reaction goes to
 * the front at once.
 */
import { supports, type RuchoirClient } from "@ruchoir/client";
import { quickReactions } from "@ruchoir/client/emoji";
import { useCallback, useSyncExternalStore } from "react";

import { useApi } from "../api/useApi";
import { useSession } from "../session/SessionProvider";

type Store = { list: readonly string[]; loading: Promise<void> | null; listeners: Set<() => void> };

const EMPTY: readonly string[] = [];
const stores = new WeakMap<RuchoirClient, Map<string, Store>>();

function storeOf(api: RuchoirClient, userId: string): Store {
  let byUser = stores.get(api);
  if (!byUser) stores.set(api, (byUser = new Map()));
  let store = byUser.get(userId);
  if (!store) byUser.set(userId, (store = { list: EMPTY, loading: null, listeners: new Set() }));
  return store;
}

function set(store: Store, list: readonly string[]) {
  store.list = list;
  for (const listener of store.listeners) listener();
}

function load(api: RuchoirClient, store: Store) {
  store.loading ??= api
    .getInstanceCapabilities()
    .then((caps) => (supports(caps, "recent_reactions") ? api.getRecentReactions() : []))
    .then((found) => set(store, [...found, ...store.list.filter((e) => !found.includes(e))]))
    .catch(() => {
      // Out of reach: the usual row meanwhile, and another try at the next long press.
      store.loading = null;
    });
}

/** A reaction just added on `api`'s instance: first of that account's recent ones from now on. */
export function noteReaction(api: RuchoirClient, userId: string, emoji: string) {
  const store = storeOf(api, userId);
  set(store, [emoji, ...store.list.filter((e) => e !== emoji)]);
}

/** The quick reactions to offer: the recent ones first, then the usual ones, `count` in all. */
export function useQuickReactions(count?: number): string[] {
  const api = useApi();
  const { state } = useSession();
  const userId = state.kind === "signedIn" ? state.user.id : "";
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!userId) return () => {};
      const store = storeOf(api, userId);
      store.listeners.add(listener);
      load(api, store);
      return () => store.listeners.delete(listener);
    },
    [api, userId],
  );
  const list = useSyncExternalStore(subscribe, () => (userId ? storeOf(api, userId).list : EMPTY));
  return quickReactions(list, count);
}
