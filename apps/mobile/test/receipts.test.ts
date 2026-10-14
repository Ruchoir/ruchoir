import { test } from "node:test";
import assert from "node:assert/strict";

import { seenMessageId } from "../src/logic/receipts.ts";

const m = (id: string, authorId: string) => ({ id, authorId });
const FEED = [m("1", "u2"), m("2", "u1"), m("3", "u1")];

test("seen_when_the_other_read_my_last_message", () => {
  assert.equal(seenMessageId([{ userId: "u2", lastReadMessageId: "3" }], FEED, "u1"), "3");
});

test("not_seen_when_their_cursor_is_older", () => {
  assert.equal(seenMessageId([{ userId: "u2", lastReadMessageId: "2" }], FEED, "u1"), null);
  assert.equal(seenMessageId([{ userId: "u2" }], FEED, "u1"), null);
});

test("a_cursor_beyond_my_last_message_counts", () => {
  const feed = [...FEED, { id: "4", authorId: "u1", kind: "system" as const }];
  assert.equal(seenMessageId([{ userId: "u2", lastReadMessageId: "4" }], feed, "u1"), "3");
});

test("nothing_when_the_last_message_is_theirs", () => {
  assert.equal(seenMessageId([{ userId: "u2", lastReadMessageId: "4" }], [...FEED, m("4", "u2")], "u1"), null);
});

test("my_own_cursor_does_not_count", () => {
  assert.equal(seenMessageId([{ userId: "u1", lastReadMessageId: "3" }], FEED, "u1"), null);
});
