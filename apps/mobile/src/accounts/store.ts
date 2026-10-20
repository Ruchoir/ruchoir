/**
 * What the phone keeps between launches about its instances (ADR 0007): the registry (which
 * instances, which is open, the last space of each) and one session token per instance.
 *
 * Everything lives in the Keychain (Android: the Keystore), readable only while the phone is unlocked
 * and never copied into a backup or to another device (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`). The
 * registry holds no secret; each token has its own entry, named after the instance's random id.
 * Beside them the app keeps only what names nothing sensitive (preferences) and downloaded files, in
 * a cache emptied at sign-out. A password typed at sign-up is never written.
 */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import { EMPTY_REGISTRY, migrateLegacy, parseRegistry, type Registry } from "./registry";

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const REGISTRY = "ruchoir.instances";
const tokenKey = (id: string) => `ruchoir.session.${id}`;

// What the single-instance version kept (ADR 0005), read once to migrate.
const LEGACY_SERVER = "ruchoir.server";
const LEGACY_TOKEN = "ruchoir.session";
const LEGACY_SPACE = "ruchoir.space";

/** A new instance's id: random, and only letters and digits, as a Keychain key requires. */
export function newInstanceId(): string {
  return Array.from(Crypto.getRandomBytes(8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function saveRegistry(registry: Registry): Promise<void> {
  await SecureStore.setItemAsync(REGISTRY, JSON.stringify(registry), OPTIONS);
}

/** The registry, made from the single-instance version's memory the first time this version runs. */
export async function loadRegistry(): Promise<Registry> {
  const stored = await SecureStore.getItemAsync(REGISTRY, OPTIONS);
  if (stored !== null) return parseRegistry(stored);
  const server = await SecureStore.getItemAsync(LEGACY_SERVER, OPTIONS);
  if (!server) return EMPTY_REGISTRY;
  const [token, space] = await Promise.all([
    SecureStore.getItemAsync(LEGACY_TOKEN, OPTIONS),
    SecureStore.getItemAsync(LEGACY_SPACE),
  ]);
  const registry = migrateLegacy(server, space, newInstanceId());
  const id = registry.instances[0].id;
  if (token) await SecureStore.setItemAsync(tokenKey(id), token, OPTIONS);
  await saveRegistry(registry);
  await Promise.all([
    SecureStore.deleteItemAsync(LEGACY_TOKEN, OPTIONS),
    SecureStore.deleteItemAsync(LEGACY_SERVER, OPTIONS),
    SecureStore.deleteItemAsync(LEGACY_SPACE),
  ]).catch(() => {});
  return registry;
}

export const tokens = {
  get: (id: string) => SecureStore.getItemAsync(tokenKey(id), OPTIONS),
  set: (id: string, token: string) => SecureStore.setItemAsync(tokenKey(id), token, OPTIONS),
  clear: (id: string) => SecureStore.deleteItemAsync(tokenKey(id), OPTIONS),
};
