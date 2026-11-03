/**
 * The preferences in force, for every screen, and where they are kept between launches: one small
 * JSON in the secure store, beside the last space chosen (`space/SpaceProvider.tsx`). They are read
 * once before the first screen is drawn (`loadPrefs`), so the app never flashes in the wrong colours
 * or language, and a change is applied at once and written behind.
 *
 * The ones that follow the account (`MOBILE_ACCOUNT_KEYS`) also go to the server, through every
 * signed-in instance: a change made here is queued (kept in the store, so one made offline goes up
 * later) and sent; a change made elsewhere is adopted without being sent back. With several
 * instances the app's are the person's once the first instance's were adopted, as on the desktop.
 */
import { mergePending, reconcileAccountPrefs, type AccountPrefsDoc, type RuchoirClient } from "@ruchoir/client";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";

import { applyLocale } from "../i18n";
import { DEFAULT_PREFS, fromWire, MOBILE_ACCOUNT_KEYS, parsePrefs, toWire, wireChanges, type Prefs, type ThemeMode } from "./prefs";

const KEY = "ruchoir.prefs";
/** What is still to send, and whether the app's account preferences are already the person's. */
const SYNC_KEY = "ruchoir.prefs.sync";

let pending: AccountPrefsDoc = {};
let shared = false;
/** Sends a change to every signed-in instance; true when every one took it (or predates the feature). */
let sender: ((patch: AccountPrefsDoc) => Promise<boolean>) | null = null;

let current: Prefs = DEFAULT_PREFS;
const listeners = new Set<() => void>();

/**
 * The phone's own controls (date pickers, the keyboard, alerts) follow the app's day or night, not
 * only the screens it draws: a forced mode is handed to the system, "automatic" gives it back.
 */
function applyMode(mode: ThemeMode) {
  Appearance.setColorScheme(mode === "auto" ? "unspecified" : mode === "night" ? "dark" : "light");
}

function apply(prefs: Prefs) {
  applyMode(prefs.mode);
  applyLocale(prefs.locale);
}

/** Read what was chosen, once, before the first screen. */
export async function loadPrefs(): Promise<Prefs> {
  const raw = await SecureStore.getItemAsync(KEY).catch(() => null);
  current = parsePrefs(raw);
  try {
    const sync = JSON.parse((await SecureStore.getItemAsync(SYNC_KEY).catch(() => null)) ?? "{}");
    if (sync && typeof sync.pending === "object" && sync.pending) pending = sync.pending;
    shared = sync?.shared === true;
  } catch {
    // Nothing to send then.
  }
  apply(current);
  listeners.forEach((listen) => listen());
  return current;
}

function keep(patch: Partial<Prefs>): Prefs {
  const before = current;
  current = { ...current, ...patch };
  if (patch.mode !== undefined && patch.mode !== before.mode) applyMode(current.mode);
  if (patch.locale !== undefined && patch.locale !== before.locale) applyLocale(current.locale);
  listeners.forEach((listen) => listen());
  void SecureStore.setItemAsync(KEY, JSON.stringify(current)).catch(() => {});
  return before;
}

function saveSync() {
  void SecureStore.setItemAsync(SYNC_KEY, JSON.stringify({ pending, shared })).catch(() => {});
}

/** Change some preferences: applied at once, kept for the next launch, sent when they follow the account. */
export function setPrefs(patch: Partial<Prefs>) {
  const before = keep(patch);
  const changes = wireChanges(before, current);
  if (Object.keys(changes).length === 0) return;
  pending = mergePending(pending, changes);
  saveSync();
  void flushAccountPrefs();
}

/** Preferences the account already holds (changed on another device): applied, not sent back. */
export function adoptPrefs(changes: AccountPrefsDoc) {
  const fresh: AccountPrefsDoc = { ...changes };
  // A key still to send is the newer choice.
  for (const key of Object.keys(pending)) delete fresh[key];
  const patch = fromWire(fresh, current);
  if (Object.keys(patch).length > 0) keep(patch);
}

/** Who sends a change to the signed-in instances (`AccountPrefsSender`), or nobody. */
export function setAccountSender(send: typeof sender) {
  sender = send;
  if (send) void flushAccountPrefs();
}

/** Send what is queued; kept for later when an instance could not be reached. */
export async function flushAccountPrefs() {
  const sent = pending;
  if (!sender || Object.keys(sent).length === 0) return;
  if (!(await sender(sent))) return;
  // Only what was sent leaves the queue: a key changed again meanwhile stays to go up next.
  const left = { ...pending };
  for (const [key, value] of Object.entries(sent)) if (left[key] === value) delete left[key];
  pending = left;
  saveSync();
}

/**
 * At sign-in on an instance: the first device sends its own, otherwise the server's win; once the
 * app's are the person's (`shared`), the instance is brought in line with them instead.
 */
export async function reconcileWith(client: RuchoirClient) {
  const server = await client.getAccountPreferences().catch(() => null);
  // Unreachable, or an instance from before account preferences: the phone's stand.
  if (!server) return;
  const { apply, push } = reconcileAccountPrefs({ local: toWire(current), server, keys: MOBILE_ACCOUNT_KEYS, shared });
  adoptPrefs(apply);
  const send = mergePending(push, pending);
  if (Object.keys(send).length > 0) await client.patchAccountPreferences(send).catch(() => {});
  if (!shared) {
    shared = true;
    saveSync();
  }
}

function subscribe(listen: () => void) {
  listeners.add(listen);
  return () => {
    listeners.delete(listen);
  };
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, () => current);
}
