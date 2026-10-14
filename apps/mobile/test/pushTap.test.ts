import { test } from "node:test";
import assert from "node:assert/strict";

import { tapData, tapTarget } from "../src/push/tap.ts";

const message = {
  id: "n1",
  kind: "mention",
  title: "#général · Atelier",
  body: "Léa vous a mentionné",
  space_id: "s1",
  conversation_id: "c1",
  message_id: "m1",
  channel_name: "général",
  actor_name: "Léa Martin",
  created_at: "2026-10-15T08:00:00Z",
};

test("a_notification_keeps_what_opening_it_needs_and_nothing_else", () => {
  assert.deepEqual(tapData(message), {
    space_id: "s1",
    conversation_id: "c1",
    message_id: "m1",
    channel_name: "général",
    actor_name: "Léa Martin",
  });
});

test("a_channel_message_opens_its_channel", () => {
  assert.deepEqual(tapTarget(tapData(message)), {
    spaceId: "s1",
    screen: "conversation",
    params: { conversationId: "c1", title: "général", channelId: "c1", kind: "channel" },
  });
});

test("a_private_message_opens_the_conversation_with_its_author", () => {
  const { channel_name: _, ...direct } = message;
  assert.deepEqual(tapTarget(tapData({ ...direct, kind: "dm" })), {
    spaceId: "s1",
    screen: "conversation",
    params: { conversationId: "c1", title: "Léa Martin", channelId: undefined, kind: "person" },
  });
});

test("a_reminder_opens_the_agenda", () => {
  assert.deepEqual(tapTarget({ event_id: "e1" }), { spaceId: undefined, screen: "agenda" });
});

test("anything_else_opens_nothing", () => {
  assert.equal(tapTarget({}), null);
  assert.equal(tapTarget(undefined), null);
  assert.equal(tapTarget({ conversation_id: 42 } as unknown as Record<string, unknown>), null);
});
