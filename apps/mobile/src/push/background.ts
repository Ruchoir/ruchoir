/**
 * What a push hands the app's background task (ADR 0006). The relay's pushes carry nothing but
 * which of two they are, not even which instance sent them:
 *
 * - a wake (Android only: on an iPhone the Notification Service Extension, `targets/notifications`,
 *   handles it without the app): ask every instance the phone is signed in to what to show
 *   (`GET /api/v1/push/pending`, as the browsers' service worker does, ADR 0007), draw it as local
 *   notifications, each carrying its instance and id, and set the icon's count;
 * - a sync, silent, on both systems: something was read on another device. Count the unread again
 *   for the icon, and take the notifications read since off the screen (`syncRead`).
 *
 * Defined at the top level of a module the entry imports (`index.ts`), as the task manager requires:
 * the task can run with no screen mounted, after the app was closed.
 */
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";

import { refreshWidgets } from "../widgets";
import { notifications, taskManager } from "./native";
import { CHANNEL, SHARED, SHARED_ACCOUNTS } from "./phone";
import { fromEvery, parseSharedAccounts } from "./shared";
import { pushKind, toDismiss, type Unread } from "./sync";
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

/** How many unread notifications one instance is asked for, to know which are still unread. */
const UNREAD_PAGE = 100;

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/**
 * Something was read on another device: put every instance's unread total on the icon, and take
 * off the screen the notifications that are read now. An instance that does not answer keeps its
 * notifications and leaves the count alone when none answers.
 */
export async function syncRead(): Promise<void> {
  const Notifications = notifications();
  if (!Notifications) return;
  const accounts = parseSharedAccounts(await SecureStore.getItemAsync(SHARED_ACCOUNTS, SHARED));
  const answers = await fromEvery(accounts, async ({ server, token }) => {
    const response = await fetch(`${server}/api/v1/notifications?unread=true&limit=${UNREAD_PAGE}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok) throw new Error(String(response.status));
    const feed = (await response.json()) as { notifications?: { id?: unknown }[]; unread_count?: number };
    const ids = (feed.notifications ?? []).flatMap((n) => (typeof n.id === "string" ? [n.id] : []));
    const count = typeof feed.unread_count === "number" ? feed.unread_count : ids.length;
    return { count, unread: { unread: new Set(ids), complete: count <= ids.length } satisfies Unread };
  });
  if (answers.length > 0) {
    await Notifications.setBadgeCountAsync(answers.reduce((sum, a) => sum + a.value.count, 0)).catch(() => false);
  }
  const byServer = new Map(answers.map((a) => [a.account.server, a.value.unread]));
  const nothingUnread = accounts.length > 0 && answers.length === accounts.length && answers.every((a) => a.value.count === 0);
  const presented = await Notifications.getPresentedNotificationsAsync().catch(() => []);
  const shown = presented.map((n) => {
    const data = (n.request.content.data ?? {}) as Record<string, unknown>;
    return { identifier: n.request.identifier, server: text(data.server), notificationId: text(data.notification_id) };
  });
  for (const identifier of toDismiss(shown, byServer, nothingUnread)) {
    await Notifications.dismissNotificationAsync(identifier).catch(() => {});
  }
  // The home screen's counts too.
  await refreshWidgets().catch(() => {});
}

// Both systems: the sync reaches the app on an iPhone too (a background push, `remote-notification`).
taskManager()?.defineTask(WAKE_TASK, async ({ data, error }) => {
  if (error) return;
  const kind = pushKind(data);
  if (kind === "sync") {
    await syncRead().catch(() => {});
    return;
  }
  // In front, the app shows what arrives itself (the realtime socket is open).
  if (kind !== "wake" || Platform.OS !== "android" || AppState.currentState === "active") return;
  await showPending().catch(() => {});
});
