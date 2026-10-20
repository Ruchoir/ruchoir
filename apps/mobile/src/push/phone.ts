/**
 * This phone's notifications (ADR 0006), from every instance it is signed in to (ADR 0007).
 *
 * The phone registers its device token with each of its instances; an instance asks the publisher's
 * relay to wake it, with a constant push and never any content, which does not even say which
 * instance woke it; the phone then asks each instance what to show (`GET /api/v1/push/pending`):
 *
 * - on iOS, the Notification Service Extension (`targets/notifications`) does, before the alert is
 *   shown;
 * - on Android, the background task of `push/background.ts` does, and draws local notifications.
 *
 * Both need the instances' addresses and session tokens while the app itself is not running, so a
 * copy is kept apart (`SHARED`): in the keychain group shared with the extensions on iOS (the
 * notification service and the widgets), readable after the first unlock so a notification can be
 * read while the phone is locked. It is written whenever the signed-in instances change, and an
 * instance leaves it when the phone signs out of it.
 *
 * Expo Go cannot receive pushes for this app: there, notifications are unavailable.
 */
import type { RuchoirClient } from "@ruchoir/client";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { notifications } from "./native";
import { serializeSharedAccounts, type SharedAccount } from "./shared";

/** Where the extensions and the background task read the instances and their tokens. */
export const SHARED: SecureStore.SecureStoreOptions = {
  keychainService: "ruchoir.push",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
/** Every signed-in instance, as `[{ server, token }]` (`push/shared.ts`). */
export const SHARED_ACCOUNTS = "push.accounts";
/** The single-instance version's copy, deleted when the list is first written. */
const LEGACY_SERVER = "push.server";
const LEGACY_TOKEN = "push.token";
/** The device token last registered, to forget it at sign-out. */
const DEVICE = "ruchoir.pushDevice";
/** Android's channel for messages and mentions. */
export const CHANNEL = "messages";

export type PhonePush = "on" | "off" | "denied" | "unavailable";

/** Whether this phone receives notifications, may be asked, or was refused by its owner. */
export async function phonePushState(): Promise<PhonePush> {
  const Notifications = notifications();
  if (!Notifications) return "unavailable";
  const { status } = await Notifications.getPermissionsAsync();
  if (status === "denied") return "denied";
  return status === "granted" && (await SecureStore.getItemAsync(DEVICE)) ? "on" : "off";
}

/** Hand the extensions (notifications, widgets) every signed-in instance and its token. */
export async function shareSessions(accounts: SharedAccount[]): Promise<void> {
  if (accounts.length === 0) await SecureStore.deleteItemAsync(SHARED_ACCOUNTS, SHARED).catch(() => {});
  else await SecureStore.setItemAsync(SHARED_ACCOUNTS, serializeSharedAccounts(accounts), SHARED);
  await SecureStore.deleteItemAsync(LEGACY_TOKEN, SHARED).catch(() => {});
  await SecureStore.deleteItemAsync(LEGACY_SERVER, SHARED).catch(() => {});
}

/** The device token, once the system granted notifications; null otherwise (never asks). */
async function deviceToken(): Promise<string | null> {
  const Notifications = notifications();
  if (!Notifications) return null;
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") return null;
  return String((await Notifications.getDevicePushTokenAsync()).data);
}

const platform = () => (Platform.OS === "ios" ? "ios" : "android");

/**
 * Turn notifications on for this phone: ask the system when `ask` (never at launch), then register
 * the device with every signed-in instance.
 */
export async function enablePhonePush(ask: boolean, clients: RuchoirClient[]): Promise<PhonePush> {
  const Notifications = notifications();
  if (!Notifications) return "unavailable";
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted" && ask) ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== "granted") return status === "denied" ? "denied" : "off";
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: "Ruchoir",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  const device = await deviceToken();
  if (!device) return "off";
  // One instance that does not answer does not keep the others from notifying.
  const results = await Promise.allSettled(clients.map((client) => client.registerPushDevice(platform(), device)));
  if (clients.length > 0 && results.every((r) => r.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
  await SecureStore.setItemAsync(DEVICE, device);
  return "on";
}

/**
 * At every start signed in, and when an instance is added: register a phone whose notifications are
 * on again with these instances, which also moves each to the account now signed in there. Never asks.
 */
export async function refreshPhonePush(clients: RuchoirClient[]): Promise<void> {
  if ((await phonePushState()) !== "on") return;
  await enablePhonePush(false, clients).catch(() => {});
}

/** Signing out of one instance: it forgets this phone, while the session still opens its door. */
export async function forgetPhoneOn(client: RuchoirClient): Promise<void> {
  const device = await SecureStore.getItemAsync(DEVICE).catch(() => null);
  if (device) await client.forgetPushDevice(device).catch(() => {});
}

/** Turn notifications off for this phone: every instance forgets it. */
export async function disablePhonePush(clients: RuchoirClient[]): Promise<void> {
  const device = await SecureStore.getItemAsync(DEVICE).catch(() => null);
  if (device) await Promise.all(clients.map((client) => client.forgetPushDevice(device).catch(() => {})));
  await SecureStore.deleteItemAsync(DEVICE).catch(() => {});
}
