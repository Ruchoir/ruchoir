/**
 * This phone's notifications (ADR 0006).
 *
 * The phone registers its device token with its instance; the instance asks the publisher's relay
 * to wake it, with a constant push and never any content; the phone then asks the instance what to
 * show (`GET /api/v1/push/pending`):
 *
 * - on iOS, the Notification Service Extension (`targets/notifications`) does, before the alert is
 *   shown;
 * - on Android, the background task of `push/background.ts` does, and draws local notifications.
 *
 * Both need the instance's address and the session token while the app itself is not running, so
 * a copy is kept apart (`SHARED`): in the keychain group shared with the extensions on iOS (the
 * notification service and the widgets), readable after the first unlock so a notification can be
 * read while the phone is locked. It is written at every start signed in, and goes at sign-out.
 *
 * Expo Go cannot receive pushes for this app: there, notifications are unavailable.
 */
import { forgetPushDevice, registerPushDevice } from "@ruchoir/client";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { currentSession } from "../api/instance";
import { notifications } from "./native";

/** Where the extension and the background task read the instance and the token. */
export const SHARED: SecureStore.SecureStoreOptions = {
  keychainService: "ruchoir.push",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
export const SHARED_SERVER = "push.server";
export const SHARED_TOKEN = "push.token";
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

/** Hand the extensions (notifications, widgets) the instance and the session token. */
export async function shareSession(): Promise<void> {
  const session = currentSession();
  if (!session) return;
  await SecureStore.setItemAsync(SHARED_SERVER, session.origin, SHARED);
  await SecureStore.setItemAsync(SHARED_TOKEN, session.token, SHARED);
}

/**
 * Turn notifications on for this phone: ask the system when `ask` (never at launch), then register
 * the device with the instance and share the session with the extension.
 */
export async function enablePhonePush(ask: boolean): Promise<PhonePush> {
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
  const device = String((await Notifications.getDevicePushTokenAsync()).data);
  await registerPushDevice(Platform.OS === "ios" ? "ios" : "android", device);
  await SecureStore.setItemAsync(DEVICE, device);
  await shareSession();
  return "on";
}

/**
 * At every start signed in (and after signing in): refresh the registration of a phone whose
 * notifications were turned on, which also moves it to the account now signed in. Never asks.
 */
export async function refreshPhonePush(): Promise<void> {
  if ((await phonePushState()) !== "on") return;
  await enablePhonePush(false).catch(() => {});
}

/** Turn notifications off for this phone, or sign out: the instance forgets it, the copy goes. */
export async function disablePhonePush(): Promise<void> {
  const device = await SecureStore.getItemAsync(DEVICE).catch(() => null);
  if (device) await forgetPushDevice(device).catch(() => {});
  await SecureStore.deleteItemAsync(DEVICE).catch(() => {});
  await SecureStore.deleteItemAsync(SHARED_TOKEN, SHARED).catch(() => {});
  await SecureStore.deleteItemAsync(SHARED_SERVER, SHARED).catch(() => {});
}
