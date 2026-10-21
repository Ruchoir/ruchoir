// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyNotificationsRead } from "./notifRead.ts";

const list = [
  { id: "a", read: false },
  { id: "b", read: false },
  { id: "c", read: true },
];

test("the_ids_read_elsewhere_are_read_here", () => {
  assert.deepEqual(applyNotificationsRead(list, { ids: ["b"], all: false }), [
    { id: "a", read: false },
    { id: "b", read: true },
    { id: "c", read: true },
  ]);
});

test("everything_read_elsewhere_is_read_here", () => {
  assert.deepEqual(
    applyNotificationsRead(list, { ids: [], all: true }).map((n) => n.read),
    [true, true, true],
  );
});

test("nothing_changes_the_same_list_is_kept", () => {
  // The same array back, so React has nothing to render again.
  assert.equal(applyNotificationsRead(list, { ids: ["c", "unknown"], all: false }), list);
  const allRead = [{ id: "x", read: true }];
  assert.equal(applyNotificationsRead(allRead, { ids: [], all: true }), allRead);
});
