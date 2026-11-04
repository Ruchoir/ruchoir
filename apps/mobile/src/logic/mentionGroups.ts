/**
 * The groups a mention can name, fetched only where a message is written or read and only for
 * someone the API will answer: `GET /groups` needs `members.view`, which a guest never holds, so
 * asking on every screen would be a 403 each time. One cached result per instance and space, shared
 * by every screen that watches it.
 */
import type { Group } from "@ruchoir/client";
import { rightsOf } from "@ruchoir/client/permissionsLogic";

/** Whether the viewer may read the groups of the space (and the instance has them at all). */
export function mayListGroups(space: { role: string; myPermissions?: string[] } | undefined, supported: boolean): boolean {
  if (!space || !supported || space.role === "guest") return false;
  return rightsOf(space).includes("members.view");
}

type Entry = {
  data: Group[] | undefined;
  listeners: Set<() => void>;
  controller: AbortController | null;
};

/**
 * A small store keyed by client (one per instance) then space. The first watcher starts the request,
 * a reload asks again, the last one to leave cancels what is still in flight; the result stays for
 * the next watcher, who gets it at once and a fresh one behind it.
 */
export function createGroupStore<C extends object>(load: (client: C, spaceId: string, signal: AbortSignal) => Promise<Group[]>) {
  const entries = new WeakMap<C, Map<string, Entry>>();

  function entryOf(client: C, spaceId: string): Entry {
    let spaces = entries.get(client);
    if (!spaces) entries.set(client, (spaces = new Map()));
    let entry = spaces.get(spaceId);
    if (!entry) spaces.set(spaceId, (entry = { data: undefined, listeners: new Set(), controller: null }));
    return entry;
  }

  function fetchAgain(client: C, spaceId: string): void {
    const entry = entryOf(client, spaceId);
    entry.controller?.abort();
    const controller = new AbortController();
    entry.controller = controller;
    load(client, spaceId, controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        entry.controller = null;
        entry.data = data;
        for (const l of [...entry.listeners]) l();
      },
      () => {
        // A refusal or a network failure: a mention just offers no group, what was known stays.
        if (!controller.signal.aborted) entry.controller = null;
      },
    );
  }

  return {
    /** The groups known so far, or undefined before the first answer. */
    read(client: C, spaceId: string): Group[] | undefined {
      return entries.get(client)?.get(spaceId)?.data;
    },
    /** Listen for a new result; returns the way to stop. The first watcher starts the request. */
    watch(client: C, spaceId: string, onChange: () => void): () => void {
      const entry = entryOf(client, spaceId);
      entry.listeners.add(onChange);
      if (entry.listeners.size === 1) fetchAgain(client, spaceId);
      return () => {
        entry.listeners.delete(onChange);
        if (entry.listeners.size === 0) {
          entry.controller?.abort();
          entry.controller = null;
        }
      };
    },
    /** Ask again (a permissions event, a resync); a no-op when nobody watches. */
    reload(client: C, spaceId: string): void {
      const entry = entries.get(client)?.get(spaceId);
      if (entry && entry.listeners.size > 0) fetchAgain(client, spaceId);
    },
  };
}
