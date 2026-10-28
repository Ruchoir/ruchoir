/**
 * The emoji the signed-in person reacted with last, which the quick reactions lead with
 * (`recent_reactions`, kept by the instance so every device shows the same). Read once, on first
 * use, from an instance that has the feature; each new reaction goes to the front at once, without
 * waiting for a second read.
 */
import { useSyncExternalStore } from "react";

import { quickReactions } from "@ruchoir/client/emoji";

import { getInstanceCapabilities, getRecentReactions, supports } from "./api";

const EMPTY: readonly string[] = [];
let recent: readonly string[] = EMPTY;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: readonly string[]) {
  recent = next;
  for (const listener of listeners) listener();
}

function load() {
  loading ??= getInstanceCapabilities()
    .then((caps) => (supports(caps, "recent_reactions") ? getRecentReactions() : []))
    .then((found) => set([...found, ...recent.filter((e) => !found.includes(e))]))
    .catch(() => {
      // Out of reach: the usual row meanwhile, and another try at the next picker.
      loading = null;
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  load();
  return () => listeners.delete(listener);
}

/** A reaction just added: first of the recent ones from now on. */
export function noteReaction(emoji: string) {
  set([emoji, ...recent.filter((e) => e !== emoji)]);
}

/** Forget them at sign-out, so the next account starts from its own. */
export function forgetRecentReactions() {
  loading = null;
  set(EMPTY);
}

/** The quick reactions to offer: the recent ones first, then the usual ones, `count` in all. */
export function useQuickReactions(count?: number): string[] {
  const list = useSyncExternalStore(subscribe, () => recent, () => EMPTY);
  return quickReactions(list, count);
}
