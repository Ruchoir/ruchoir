/**
 * What a notification carries for the app to open on a tap, and what it opens (ADR 0006). Shared by
 * Android's local notifications (`push/background.ts`) and iOS's extension, which writes the same
 * keys under the notification's `body` (`targets/notifications`). Free of the native modules so Node
 * tests it.
 */

/** One item of `GET /api/v1/push/pending`. */
export type PendingItem = {
  id: string;
  kind: string;
  title: string;
  body: string;
  space_id?: string;
  conversation_id?: string;
  message_id?: string;
  event_id?: string;
  channel_name?: string;
  actor_name?: string;
  created_at: string;
};

const KEYS = ["space_id", "conversation_id", "message_id", "event_id", "channel_name", "actor_name"] as const;

/** The item's ids and names, as the notification keeps them (strings only, the absent ones left out). */
export function tapData(item: PendingItem): Record<string, string> {
  const data: Record<string, string> = {};
  for (const key of KEYS) {
    const value = item[key];
    if (value) data[key] = value;
  }
  return data;
}

export type TapTarget =
  | {
      spaceId?: string;
      screen: "conversation";
      params: { conversationId: string; title: string; channelId?: string; kind: "channel" | "person" };
    }
  | { spaceId?: string; screen: "agenda" };

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** Where a tap leads: the conversation of a message, the agenda for an event, nowhere otherwise. */
export function tapTarget(data: Record<string, unknown> | undefined | null): TapTarget | null {
  if (!data) return null;
  const spaceId = text(data.space_id);
  const conversationId = text(data.conversation_id);
  if (conversationId) {
    const channel = text(data.channel_name);
    return {
      spaceId,
      screen: "conversation",
      params: {
        conversationId,
        title: channel ?? text(data.actor_name) ?? "Ruchoir",
        channelId: channel ? conversationId : undefined,
        kind: channel ? "channel" : "person",
      },
    };
  }
  if (text(data.event_id)) return { spaceId, screen: "agenda" };
  return null;
}
