/**
 * Android: what a push wakes (ADR 0006). The relay's data message carries nothing but a wake-up, not
 * even which instance sent it; this task asks every instance the phone is signed in to what to show
 * (`GET /api/v1/push/pending`, as the browsers' service worker does, ADR 0007) and draws it as local
 * notifications, each carrying its instance for the tap, and sets the icon's count. iOS does the same in its Notification Service Extension
 * (`targets/notifications`), since a woken iPhone app runs no JavaScript.
 *
 * Defined at the top level of a module the entry imports (`index.ts`), as the task manager requires:
 * the task can run with no screen mounted, after the app was closed.
 */
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";

import { notifications, taskManager } from "./native";
import { CHANNEL, SHARED, SHARED_ACCOUNTS } from "./phone";
import { fromEvery, parseSharedAccounts } from "./shared";
import { newestPending, tapData, type PendingItem } from "./tap";

export const WAKE_TASK = "ruchoir.push.wake";

type Pending = { silent: boolean; items: PendingItem[] };

/**
 * Ask every instance what is waiting and draw it; a notification already drawn is replaced, not
 * doubled. An instance that does not answer never keeps the others' from showing.
 */
export async function showPending(): Promise<void> {
  const Notifications = notifications();
  if (!Notifications) return;
  const accounts = parseSharedAccounts(await SecureStore.getItemAsync(SHARED_ACCOUNTS, SHARED));
  const answers = await fromEvery(accounts, async ({ server, token }) => {
    const response = await fetch(`${server}/api/v1/push/pending`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as Pending;
  });
  const silent = answers.length > 0 && answers.every((a) => a.value.silent);
  const items = newestPending(
    answers.map((a) => ({ server: a.account.server, items: a.value.items })),
    3,
  );
  // The icon's count: every instance's unread notifications, as the bell counts them.
  const counts = await fromEvery(accounts, async ({ server, token }) => {
    const response = await fetch(`${server}/api/v1/notifications?unread=true&limit=1`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok) throw new Error(String(response.status));
    return ((await response.json()) as { unread_count?: number }).unread_count ?? 0;
  });
  if (counts.length > 0) await Notifications.setBadgeCountAsync(counts.reduce((sum, c) => sum + c.value, 0)).catch(() => false);
  // Oldest first, so the newest ends on top of the shade.
  for (const { server, item } of items.reverse()) {
    await Notifications.scheduleNotificationAsync({
      identifier: item.id,
      content: {
        title: item.title,
        body: item.body,
        sound: silent ? undefined : "default",
        data: { ...tapData(item), server },
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
