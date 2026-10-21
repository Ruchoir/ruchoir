/**
 * The live events the screens hear, and how the realtime client's handlers turn into them.
 *
 * Every event the server pushes and the app draws is relayed here (the files' "being edited" is not:
 * the app shows no editor yet). `affects` says, for each list a screen loads, which events change it,
 * so every screen reloads on the same rule. Kept free of React so Node tests it.
 */
import type { ApiMessage, MemberIdentity, Presence, RealtimeHandlers } from "@ruchoir/client";

export type RealtimeEvent =
  | { type: "message"; change: "created" | "updated" | "deleted"; conversationId: string; message: ApiMessage }
  /** A change I made, drawn before the server confirms it (a reaction, a pin, an edit): screens only. */
  | { type: "patched"; conversationId: string; message: ApiMessage }
  /** Someone's reaction added or removed. Mine are already on screen. */
  | { type: "reaction"; conversationId: string; messageId: string; emoji: string; userId: string; added: boolean }
  | { type: "pinned"; conversationId: string; messageId: string; pinned: boolean }
  /** A notification came, or (`read`) some were read on one of my devices. */
  | { type: "notification"; read?: true }
  | { type: "readCursor"; conversationId: string; userId: string; lastReadMessageId: string }
  | { type: "typing"; conversationId: string; userId: string }
  | { type: "presence"; userId: string; presence: Presence }
  /** My spaces changed: renamed, left, removed, or my role in one. */
  | { type: "spaces" }
  /**
   * A space's channels changed; `channelId` names the one, `deleted` when it is gone, `membership`
   * when someone's place in it changed (mine included, from another device or by a moderator).
   */
  | {
      type: "channels";
      spaceId?: string;
      channelId?: string;
      deleted?: true;
      membership?: { userId: string; change: "joined" | "left" | "removed" | "role" };
    }
  /** Someone joined or left a space, or their role changed there. */
  | { type: "members"; spaceId: string; userId: string }
  /** Someone's name, title or photo changed (mine included, from any device). */
  | { type: "member"; member: MemberIdentity }
  | { type: "calendar" }
  | { type: "files"; spaceId: string };

/** The client's handlers, each relaying its event; a reconnection asks every screen to read again. */
export function handlersFor(emit: (event: RealtimeEvent) => void, onReconnect: () => void): RealtimeHandlers {
  return {
    onReconnect,
    onMessageCreated: (conversationId, message) => emit({ type: "message", change: "created", conversationId, message }),
    onMessageUpdated: (conversationId, message) => emit({ type: "message", change: "updated", conversationId, message }),
    onMessageDeleted: (conversationId, message) => emit({ type: "message", change: "deleted", conversationId, message }),
    onReaction: (conversationId, r) => emit({ type: "reaction", conversationId, ...r }),
    onPinned: (conversationId, messageId, pinned) => emit({ type: "pinned", conversationId, messageId, pinned }),
    onNotification: () => emit({ type: "notification" }),
    onNotificationsRead: () => emit({ type: "notification", read: true }),
    onReadCursor: (conversationId, userId, lastReadMessageId) => emit({ type: "readCursor", conversationId, userId, lastReadMessageId }),
    onTyping: (conversationId, userId) => emit({ type: "typing", conversationId, userId }),
    onPresence: (userId, presence) => emit({ type: "presence", userId, presence }),
    onMemberJoined: (member) => emit({ type: "members", spaceId: member.spaceId, userId: member.userId }),
    onMemberLeft: (spaceId, userId) => emit({ type: "members", spaceId, userId }),
    onMemberRoleChanged: (spaceId, userId) => {
      emit({ type: "members", spaceId, userId });
      emit({ type: "spaces" });
    },
    onMemberUpdated: (member) => emit({ type: "member", member }),
    onSpaceUpdated: () => emit({ type: "spaces" }),
    onSpaceRemoved: () => emit({ type: "spaces" }),
    onChannelsReordered: (spaceId) => emit({ type: "channels", spaceId }),
    onChannelCreated: (channel) => emit({ type: "channels", spaceId: channel.spaceId, channelId: channel.id }),
    onChannelUpdated: (channel) => emit({ type: "channels", spaceId: channel.spaceId, channelId: channel.id }),
    onChannelDeleted: (spaceId, channelId) => emit({ type: "channels", spaceId, channelId, deleted: true }),
    onChannelMembership: ({ spaceId, channelId, userId, change }) =>
      emit({ type: "channels", spaceId, channelId, membership: { userId, change } }),
    onCalendarChanged: () => emit({ type: "calendar" }),
    onFilesUpdated: (spaceId) => emit({ type: "files", spaceId }),
    onFilesDeleted: (spaceId) => emit({ type: "files", spaceId }),
  };
}

/** The channel notices that say its roster changed: the web refreshes its member panel on them too. */
const ROSTER_NOTICES = ["channel_joined", "channel_left", "channel_removed"];

/** A space's channels event, unless it names another space. */
const inSpace = (event: { spaceId?: string }, spaceId: string) => !event.spaceId || event.spaceId === spaceId;

/** Which events change each list a screen loads. */
export const affects = {
  /** The conversations of a space: their last messages, unread counts, names and faces. */
  conversations: (e: RealtimeEvent, spaceId: string) =>
    e.type === "message" ||
    e.type === "readCursor" ||
    e.type === "member" ||
    (e.type === "members" && e.spaceId === spaceId) ||
    (e.type === "channels" && inSpace(e, spaceId)),
  /** The people of a space. */
  members: (e: RealtimeEvent, spaceId: string) => e.type === "member" || (e.type === "members" && e.spaceId === spaceId),
  /** The channels of a space. */
  channels: (e: RealtimeEvent, spaceId: string) => e.type === "channels" && inSpace(e, spaceId),
  /** The people of a channel: a face or a name, or the channel itself changed. */
  channelMembers: (e: RealtimeEvent, channelId: string) =>
    e.type === "member" ||
    e.type === "members" ||
    (e.type === "channels" && e.channelId === channelId) ||
    (e.type === "message" && e.conversationId === channelId && ROSTER_NOTICES.includes(e.message.system?.event ?? "")),
  /** A conversation's pinned messages: pinned, unpinned, or one of them edited or deleted. */
  pins: (e: RealtimeEvent, conversationId: string) =>
    (e.type === "pinned" && e.conversationId === conversationId) ||
    (e.type === "message" && e.conversationId === conversationId && e.change !== "created"),
};
