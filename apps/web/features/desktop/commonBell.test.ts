// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";

import { commonBell, type OtherFeed } from "./commonBell.ts";

type Item = { id: string; createdAt: string; instanceId?: string; instanceLabel?: string };

const api = (id: string, createdAt: string) =>
  ({ id, kind: "mention", conversationId: "c", spaceId: "s", spaceName: "S", messageId: "m", actor: "A", preview: "", createdAt, read: false }) as const;

const toItem = (n: { id: string; createdAt: string }, instanceId: string, instanceLabel: string): Item => ({
  id: n.id,
  createdAt: n.createdAt,
  instanceId,
  instanceLabel,
});

const ids = (items: Item[]) => items.map((i) => i.id);

test("others_are_merged_newest_first", () => {
  const own: Item[] = [{ id: "own2", createdAt: "2026-10-21T10:00:02Z" }, { id: "own0", createdAt: "2026-10-21T10:00:00Z" }];
  const others: OtherFeed[] = [
    { instanceId: "b", label: "boulot", items: [api("b3", "2026-10-21T10:00:03Z"), api("b1", "2026-10-21T10:00:01Z")] },
  ];
  assert.deepEqual(ids(commonBell(own, others, toItem)), ["b3", "own2", "b1", "own0"]);
});

test("each_other_item_names_its_instance", () => {
  const others: OtherFeed[] = [{ instanceId: "b", label: "boulot", items: [api("b1", "2026-10-21T10:00:01Z")] }];
  const [item] = commonBell([], others, toItem);
  assert.equal(item.instanceId, "b");
  assert.equal(item.instanceLabel, "boulot");
});

test("own_items_keep_no_instance", () => {
  const own: Item[] = [{ id: "own", createdAt: "2026-10-21T10:00:00Z" }];
  const [item] = commonBell(own, [], toItem);
  assert.equal(item.instanceId, undefined);
});

test("an_other_instance_with_more_pages_does_not_let_older_items_jump_ahead", () => {
  // Instance b has more to fetch beyond 10:00:05; instance c's 10:00:01 must wait for that page.
  const others: OtherFeed[] = [
    { instanceId: "b", label: "boulot", items: [api("b9", "2026-10-21T10:00:09Z"), api("b5", "2026-10-21T10:00:05Z")], next: "x" },
    { instanceId: "c", label: "chorale", items: [api("c7", "2026-10-21T10:00:07Z"), api("c1", "2026-10-21T10:00:01Z")] },
  ];
  assert.deepEqual(ids(commonBell([], others, toItem)), ["b9", "c7", "b5"]);
});
