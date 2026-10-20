import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeInboxes } from "../src/accounts/inbox.ts";

const n = (id: string, createdAt: string) =>
  ({ id, kind: "mention", conversationId: "c", spaceId: "s", spaceName: "S", messageId: "m", actor: "A", preview: "", createdAt, read: false }) as const;

test("two_inboxes_merge_newest_first_each_item_with_its_instance", () => {
  const { items, more } = mergeInboxes([
    { instanceId: "a", items: [n("a2", "2026-10-20T10:00:00Z"), n("a1", "2026-10-20T08:00:00Z")] },
    { instanceId: "b", items: [n("b1", "2026-10-20T09:00:00Z")] },
  ]);
  assert.deepEqual(
    items.map((i) => i.key),
    ["a:a2", "b:b1", "a:a1"],
  );
  assert.equal(more, false);
});

test("an_instance_with_more_pages_holds_back_what_is_older_than_its_last_item", () => {
  const { items, more } = mergeInboxes([
    // b has older pages: nothing older than its last item (09:00) may show yet.
    { instanceId: "a", items: [n("a2", "2026-10-20T10:00:00Z"), n("a1", "2026-10-20T08:00:00Z")] },
    { instanceId: "b", items: [n("b2", "2026-10-20T11:00:00Z"), n("b1", "2026-10-20T09:00:00Z")], next: "b1" },
  ]);
  assert.deepEqual(
    items.map((i) => i.key),
    ["b:b2", "a:a2", "b:b1"],
  );
  assert.equal(more, true);
});

test("the_same_id_on_two_instances_stays_two_items", () => {
  const { items } = mergeInboxes([
    { instanceId: "a", items: [n("x", "2026-10-20T10:00:00Z")] },
    { instanceId: "b", items: [n("x", "2026-10-20T10:00:00Z")] },
  ]);
  assert.deepEqual(
    items.map((i) => i.key),
    ["a:x", "b:x"],
  );
});
