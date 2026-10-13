import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeMessages } from "../src/realtime/merge.ts";

const msg = (id: string, createdAt: string, body = id) => ({ id, createdAt, body, author: "Léa" }) as never;

test("a_message_seen_twice_appears_once", () => {
  const a = msg("a", "2026-10-13T10:00:00Z");
  const merged = mergeMessages([a], [a, msg("b", "2026-10-13T10:01:00Z")]);
  assert.deepEqual(merged.map((m: { id: string }) => m.id), ["a", "b"]);
});

test("an_edit_replaces_the_older_version", () => {
  const merged = mergeMessages([msg("a", "2026-10-13T10:00:00Z", "before")], [msg("a", "2026-10-13T10:00:00Z", "after")]);
  assert.equal(merged.length, 1);
  assert.equal((merged[0] as { body: string }).body, "after");
});

test("order_is_by_time", () => {
  const merged = mergeMessages([msg("late", "2026-10-13T11:00:00Z")], [msg("early", "2026-10-13T09:00:00Z")]);
  assert.deepEqual(merged.map((m: { id: string }) => m.id), ["early", "late"]);
});

test("nothing_new_keeps_the_same_array", () => {
  const list = [msg("a", "2026-10-13T10:00:00Z")];
  assert.equal(mergeMessages(list, []), list);
});
