import { test } from "node:test";
import assert from "node:assert/strict";

import { affects, handlersFor, type RealtimeEvent } from "../src/realtime/events.ts";

const BOB = { userId: "u2", name: "Bob B." } as never;

function relay() {
  const out: RealtimeEvent[] = [];
  let reconnects = 0;
  const handlers = handlersFor((event) => out.push(event), () => reconnects++);
  return { out, handlers, reconnects: () => reconnects };
}

test("space_and_channel_changes_are_relayed", () => {
  const { out, handlers, reconnects } = relay();
  handlers.onMemberJoined!({ userId: "u2", name: "Bob", role: "member", spaceId: "s1" } as never);
  handlers.onMemberLeft!("s1", "u2");
  handlers.onMemberRoleChanged!("s1", "u2", "admin");
  handlers.onMemberUpdated!(BOB);
  handlers.onChannelsReordered!("s1");
  handlers.onChannelCreated!({ id: "c1", spaceId: "s1", name: "a", type: "public" });
  handlers.onChannelUpdated!({ id: "c1", spaceId: "s1", name: "b", type: "public" });
  handlers.onChannelDeleted!("s1", "c1");
  handlers.onSpaceUpdated!({ id: "s1", name: "S", slug: "s" });
  handlers.onSpaceRemoved!("s1", "left");
  handlers.onReconnect!();
  assert.deepEqual(out, [
    { type: "members", spaceId: "s1", userId: "u2" },
    { type: "members", spaceId: "s1", userId: "u2" },
    { type: "members", spaceId: "s1", userId: "u2" },
    // A role decides what one may do there: the spaces, which carry mine, are read again.
    { type: "spaces" },
    { type: "member", member: BOB },
    { type: "channels", spaceId: "s1" },
    { type: "channels", spaceId: "s1", channelId: "c1" },
    { type: "channels", spaceId: "s1", channelId: "c1" },
    { type: "channels", spaceId: "s1", channelId: "c1", deleted: true },
    { type: "spaces" },
    { type: "spaces" },
  ]);
  assert.equal(reconnects(), 1);
});

test("conversation_changes_are_relayed", () => {
  const { out, handlers } = relay();
  const message = { id: "m1" } as never;
  handlers.onMessageCreated!("k1", message);
  handlers.onMessageUpdated!("k1", message);
  handlers.onMessageDeleted!("k1", message);
  handlers.onReaction!("k1", { messageId: "m1", emoji: "👍", userId: "u2", added: true });
  handlers.onPinned!("k1", "m1", true);
  handlers.onReadCursor!("k1", "u2", "m1");
  handlers.onTyping!("k1", "u2");
  handlers.onPresence!("u2", "away");
  handlers.onNotification!({} as never);
  handlers.onNotificationsRead!({ ids: ["n1"], all: false, unreadCount: 0 });
  handlers.onCalendarChanged!("cal1");
  handlers.onFilesUpdated!("s1", {} as never);
  handlers.onFilesDeleted!("s1", ["f1"]);
  assert.deepEqual(
    out.map((e) => e.type),
    ["message", "message", "message", "reaction", "pinned", "readCursor", "typing", "presence", "notification", "notification", "calendar", "files", "files"],
  );
  // Only the second says something was read: the shade is cleaned on it.
  assert.deepEqual(
    out.filter((e) => e.type === "notification").map((e) => e.type === "notification" && e.read),
    [undefined, true],
  );
});

test("each_list_hears_what_changes_it", () => {
  const members: RealtimeEvent = { type: "members", spaceId: "s1", userId: "u2" };
  const renamed: RealtimeEvent = { type: "member", member: BOB };
  const elsewhere: RealtimeEvent = { type: "channels", spaceId: "s2" };
  // The conversation list: messages, reads, its space's channels, and people's names and faces.
  assert.ok(affects.conversations({ type: "readCursor", conversationId: "k", userId: "u", lastReadMessageId: "m" }, "s1"));
  assert.ok(affects.conversations(renamed, "s1"));
  assert.ok(affects.conversations({ type: "channels", spaceId: "s1" }, "s1"));
  assert.ok(!affects.conversations(elsewhere, "s1"));
  assert.ok(affects.conversations(members, "s1"));
  // A space's people.
  assert.ok(affects.members(members, "s1"));
  assert.ok(!affects.members({ ...members, spaceId: "s2" } as RealtimeEvent, "s1"));
  assert.ok(affects.members(renamed, "s1"));
  // A space's channels: an event that names no space may be this one.
  assert.ok(affects.channels({ type: "channels" }, "s1"));
  assert.ok(!affects.channels(elsewhere, "s1"));
  // A channel's people.
  assert.ok(affects.channelMembers(renamed, "c1"));
  assert.ok(affects.channelMembers({ type: "channels", spaceId: "s1", channelId: "c1" }, "c1"));
  assert.ok(!affects.channelMembers({ type: "channels", spaceId: "s1", channelId: "c2" }, "c1"));
  // A conversation's pins.
  assert.ok(affects.pins({ type: "pinned", conversationId: "c1", messageId: "m", pinned: true }, "c1"));
  assert.ok(!affects.pins({ type: "pinned", conversationId: "c2", messageId: "m", pinned: true }, "c1"));
});

test("a_place_in_a_channel_is_relayed_and_moves_its_roster", () => {
  const { out, handlers } = relay();
  handlers.onChannelMembership!({ spaceId: "s1", channelId: "c1", userId: "u2", change: "removed" });
  assert.deepEqual(out, [{ type: "channels", spaceId: "s1", channelId: "c1", membership: { userId: "u2", change: "removed" } }]);
  assert.ok(affects.channelMembers(out[0], "c1"));
  assert.ok(affects.conversations(out[0], "s1"));
  // The channel's own notice of an arrival or a departure moves its roster too, as on the web.
  const notice = (event: string): RealtimeEvent => ({
    type: "message",
    change: "created",
    conversationId: "c1",
    message: { id: "m", system: { event } } as never,
  });
  assert.ok(affects.channelMembers(notice("channel_joined"), "c1"));
  assert.ok(affects.channelMembers(notice("channel_removed"), "c1"));
  assert.ok(!affects.channelMembers(notice("channel_renamed"), "c1"));
  assert.ok(!affects.channelMembers({ ...notice("channel_joined"), conversationId: "c2" } as RealtimeEvent, "c1"));
});

test("a_pinned_message_edited_or_deleted_moves_the_pins", () => {
  const changed = (change: "created" | "updated" | "deleted", conversationId = "c1"): RealtimeEvent => ({
    type: "message",
    change,
    conversationId,
    message: { id: "m" } as never,
  });
  assert.ok(affects.pins(changed("updated"), "c1"));
  assert.ok(affects.pins(changed("deleted"), "c1"));
  // A new message is never pinned yet; another conversation's never concerns these pins.
  assert.ok(!affects.pins(changed("created"), "c1"));
  assert.ok(!affects.pins(changed("updated", "c2"), "c1"));
});
