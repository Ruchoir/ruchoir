/**
 * The preferences in force, for every screen, and where they are kept between launches: one small
 * JSON in the secure store, beside the last space chosen (`space/SpaceProvider.tsx`). They are read
 * once before the first screen is drawn (`loadPrefs`), so the app never flashes in the wrong colours
 * or language, and a change is applied at once and written behind.
 *
 * The ones that follow the account (`MOBILE_ACCOUNT_KEYS`) also go to the server, through every
 * signed-in instance: a change made here is queued (kept in the store, so one made offline goes up
 * later) and sent, one send at a time; a change made elsewhere is adopted without being sent back
 * to where it came from (with several instances, it is passed on to the others). At each sign-in,
 * and when the connection comes back, the account is read again: the first time this phone syncs
 * with an account the two are merged, afterwards the server's win (`reconcileAccountPrefs`).
 */
import { mergePending, reconcileAccountPrefs, type AccountPrefsDoc, type RuchoirClient } from "@ruchoir/client";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";

import { applyLocale } from "../i18n";
import { DEFAULT_PREFS, fromWire, MOBILE_ACCOUNT_KEYS, parsePrefs, toWire, wireChanges, type Prefs, type ThemeMode } from "./prefs";

const KEY = "ruchoir.prefs";
/** What is still to send, and the accounts (user ids) this phone already synced with once. */
const SYNC_KEY = "ruchoir.prefs.sync";

let pending: AccountPrefsDoc = {};
let synced: string[] = [];
let sending = false;
/**
 * Sends a change to the signed-in instances (all of them, or all but `except`); true when every
 * one took it, predates the feature, or refused it for good (the next reading of the account puts
 * the server's value back).
 */
let sender: ((patch: AccountPrefsDoc, except?: RuchoirClient) => Promise<boolean>) | null = null;

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
    if (Array.isArray(sync?.synced)) synced = sync.synced.filter((id: unknown) => typeof id === "string");
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
  void SecureStore.setItemAsync(SYNC_KEY, JSON.stringify({ pending, synced })).catch(() => {});
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

/**
 * Preferences the account already holds (read at sign-in, or changed on another device): applied,
 * not sent back. Returns what changed here, as wire keys.
 */
export function adoptPrefs(changes: AccountPrefsDoc): AccountPrefsDoc {
  const fresh: AccountPrefsDoc = { ...changes };
  // A key still to send is the newer choice.
  for (const key of Object.keys(pending)) delete fresh[key];
  const patch = fromWire(fresh, current);
  if (Object.keys(patch).length === 0) return {};
  const before = keep(patch);
  return wireChanges(before, current);
}

/** The server's values for `keys`, `null` for one it does not hold (back to its default). */
function valuesOf(server: AccountPrefsDoc, keys: Iterable<string>): AccountPrefsDoc {
  const out: AccountPrefsDoc = {};
  for (const key of keys) out[key] = key in server ? server[key] : null;
  return out;
}

/**
 * A change announced by one instance: its document is read again (two changes announced out of
 * order still end on its state), adopted, and passed on to the other instances so they agree.
 */
export async function adoptRemote(client: RuchoirClient, changes: AccountPrefsDoc) {
  const server = await client.getAccountPreferences().catch(() => null);
  if (!server) return;
  const changed = adoptPrefs(valuesOf(server, Object.keys(changes)));
  if (Object.keys(changed).length > 0 && sender) void sender(changed, client);
}

/** Who sends a change to the signed-in instances (`AccountPrefsSender`), or nobody. */
export function setAccountSender(send: typeof sender) {
  sender = send;
  if (send) void flushAccountPrefs();
}

/** Send what is queued, one send at a time; kept for later when an instance could not be reached. */
export async function flushAccountPrefs() {
  const sent = pending;
  if (!sender || sending || Object.keys(sent).length === 0) return;
  sending = true;
  let taken = false;
  try {
    taken = await sender(sent);
  } finally {
    sending = false;
  }
  if (!taken) return;
  // Only what was sent leaves the queue: a key changed again meanwhile stays to go up next.
  const left = { ...pending };
  for (const [key, value] of Object.entries(sent)) if (left[key] === value) delete left[key];
  pending = left;
  saveSync();
  if (Object.keys(pending).length > 0) void flushAccountPrefs();
}

/**
 * At sign-in on an instance, and when its connection comes back: read the account. The first time
 * this phone syncs with it, the two are merged (the phone sends what it chose for the keys the
 * account does not hold yet); afterwards the server's win, so a change made on the web while the
 * phone was closed is what it shows.
 */
export async function reconcileWith(client: RuchoirClient, userId: string) {
  const server = await client.getAccountPreferences().catch(() => null);
  // Unreachable, or an instance from before account preferences: the phone's stand.
  if (!server) return;
  const first = !synced.includes(userId);
  const { apply, push } = reconcileAccountPrefs({
    local: toWire(current),
    server,
    keys: MOBILE_ACCOUNT_KEYS,
    defaults: toWire(DEFAULT_PREFS),
    first,
  });
  adoptPrefs(apply);
  // Queued like a change made here: kept until the instances took it.
  if (Object.keys(push).length > 0) pending = mergePending(push, pending);
  if (first) synced = [...synced, userId];
  saveSync();
  await flushAccountPrefs();
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
