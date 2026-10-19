/**
 * Android: what a push wakes (ADR 0006). The relay's data message carries nothing but a wake-up; this
 * task asks the instance what to show (`GET /api/v1/push/pending`, as the browsers' service worker
 * does) and draws it as local notifications. iOS does the same in its Notification Service Extension
 * (`targets/notifications`), since a woken iPhone app runs no JavaScript.
 *
 * Defined at the top level of a module the entry imports (`index.ts`), as the task manager requires:
 * the task can run with no screen mounted, after the app was closed.
 */
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";

import { notifications, taskManager } from "./native";
import { CHANNEL, SHARED, SHARED_SERVER, SHARED_TOKEN } from "./phone";
import { tapData, type PendingItem } from "./tap";

export const WAKE_TASK = "ruchoir.push.wake";

type Pending = { silent: boolean; items: PendingItem[] };

/** Ask the instance what is waiting and draw it; a notification already drawn is replaced, not doubled. */
export async function showPending(): Promise<void> {
  const Notifications = notifications();
  if (!Notifications) return;
  const [server, token] = await Promise.all([
    SecureStore.getItemAsync(SHARED_SERVER, SHARED),
    SecureStore.getItemAsync(SHARED_TOKEN, SHARED),
  ]);
  if (!server || !token) return;
  const response = await fetch(`${server}/api/v1/push/pending`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!response.ok) return;
  const pending = (await response.json()) as Pending;
  // Oldest first, so the newest ends on top of the shade.
  for (const item of pending.items.slice(0, 3).reverse()) {
    await Notifications.scheduleNotificationAsync({
      identifier: item.id,
      content: {
        title: item.title,
        body: item.body,
        sound: pending.silent ? undefined : "default",
        data: tapData(item),
      },
      trigger: { channelId: CHANNEL },
    });
  }
}

if (Platform.OS === "android") {
  taskManager()?.defineTask(WAKE_TASK, async ({ error }) => {
    // In front, the app shows what arrives itself (the realtime socket is open).
    if (error || AppState.currentState === "active") return;
    await showPending().catch(() => {});
  });
}
