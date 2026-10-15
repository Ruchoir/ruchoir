/**
 * What the lock keeps on this phone, per account, in the Keychain (`lock/AppLock.tsx`): whether it is
 * on (`logic/pin.ts`), the PIN, and the wrong PINs typed in a row. The PIN itself is never stored: a
 * random salt and the SHA-256 of salt and PIN, never copied into a backup or to another device. The
 * count of wrong PINs is kept there too, so closing the app does not start it over.
 */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import { toHex } from "../logic/handoff";
import { FLAG_ON, FLAG_RESET, readFlag, type LockFlag } from "../logic/pin";

const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const flagKey = (userId: string) => `ruchoir.lock.${userId}`;
const pinKey = (userId: string) => `ruchoir.lock.${userId}.pin`;
const failuresKey = (userId: string) => `ruchoir.lock.${userId}.failures`;

type Stored = { salt: string; digest: string };

const digestOf = (salt: string, pin: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);

export type LockState = { flag: LockFlag; hasPin: boolean; failures: number };

export async function readLock(userId: string): Promise<LockState> {
  const [flag, pin, failures] = await Promise.all([
    SecureStore.getItemAsync(flagKey(userId)),
    SecureStore.getItemAsync(pinKey(userId), OPTIONS),
    SecureStore.getItemAsync(failuresKey(userId), OPTIONS),
  ]);
  return { flag: readFlag(flag), hasPin: pin !== null, failures: Number(failures) || 0 };
}

export async function turnOn(userId: string, pin: string): Promise<void> {
  await savePin(userId, pin);
  await SecureStore.setItemAsync(flagKey(userId), FLAG_ON);
}

export async function savePin(userId: string, pin: string): Promise<void> {
  const salt = toHex(Crypto.getRandomBytes(16));
  const stored: Stored = { salt, digest: await digestOf(salt, pin) };
  await SecureStore.setItemAsync(pinKey(userId), JSON.stringify(stored), OPTIONS);
  await SecureStore.deleteItemAsync(failuresKey(userId), OPTIONS);
}

/** Whether `pin` is the one chosen; false when there is none. */
export async function checkPin(userId: string, pin: string): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(pinKey(userId), OPTIONS);
  if (!raw) return false;
  try {
    const stored = JSON.parse(raw) as Stored;
    return (await digestOf(stored.salt, pin)) === stored.digest;
  } catch {
    return false;
  }
}

export async function setFailures(userId: string, failures: number): Promise<void> {
  if (failures === 0) await SecureStore.deleteItemAsync(failuresKey(userId), OPTIONS);
  else await SecureStore.setItemAsync(failuresKey(userId), String(failures), OPTIONS);
}

/** The lock off: nothing of it left on the phone. */
export async function turnOff(userId: string): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(flagKey(userId)),
    SecureStore.deleteItemAsync(pinKey(userId), OPTIONS),
    SecureStore.deleteItemAsync(failuresKey(userId), OPTIONS),
  ]);
}

/** A forgotten PIN: it goes, and a new one is chosen after signing in again. */
export async function resetPin(userId: string): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(pinKey(userId), OPTIONS), SecureStore.deleteItemAsync(failuresKey(userId), OPTIONS)]);
  await SecureStore.setItemAsync(flagKey(userId), FLAG_RESET);
}
