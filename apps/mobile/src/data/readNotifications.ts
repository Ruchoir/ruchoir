/**
 * A conversation read on the phone files its notifications as read, the way the web does when it
 * opens one: otherwise "To look at now" kept a mention that had been read, until the web read it.
 * Then every screen hears that the notifications changed, so Today redraws at once.
 */
import { getNotifications, markNotificationRead } from "@ruchoir/client";

import type { RealtimeEvent } from "../realtime/events";

export async function readNotificationsOf(conversationId: string, emit: (event: RealtimeEvent) => void): Promise<void> {
  const page = await getNotifications({ unread: true, limit: 100 });
  const here = page.notifications.filter((n) => !n.read && n.conversationId === conversationId);
  if (!here.length) return;
  await Promise.all(here.map((n) => markNotificationRead(n.id).catch(() => {})));
  emit({ type: "notification" });
}
