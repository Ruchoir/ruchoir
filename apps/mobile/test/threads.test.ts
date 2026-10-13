import { test } from "node:test";
import assert from "node:assert/strict";

import { bumpReplies, replyDelta } from "../src/logic/threads.ts";

const root = { id: "r", replies: 2, replyAuthors: ["Léa", "Hugo"], lastReplyAt: "2026-10-13T09:00:00Z" };

test("a_reply_arriving_bumps_the_count_and_puts_its_author_first", () => {
  const after = bumpReplies(root, 1, "Hugo", "2026-10-13T10:42:00Z");
  assert.equal(after.replies, 3);
  assert.deepEqual(after.replyAuthors, ["Hugo", "Léa"]);
  assert.equal(after.lastReplyAt, "2026-10-13T10:42:00Z");
});

test("the_faces_stop_at_three", () => {
  const after = bumpReplies({ ...root, replyAuthors: ["A", "B", "C"] }, 1, "D", "2026-10-13T10:00:00Z");
  assert.deepEqual(after.replyAuthors, ["D", "A", "B"]);
});

test("a_reply_taken_back_lowers_the_count_and_leaves_the_faces", () => {
  const after = bumpReplies(root, -1);
  assert.equal(after.replies, 1);
  assert.deepEqual(after.replyAuthors, ["Léa", "Hugo"]);
  assert.equal(after.lastReplyAt, root.lastReplyAt);
});

test("the_last_reply_taken_back_leaves_no_thread", () => {
  const after = bumpReplies({ id: "r", replies: 1, replyAuthors: ["Léa"], lastReplyAt: "x" }, -1);
  assert.equal(after.replies, undefined);
  assert.equal(after.lastReplyAt, undefined);
});

test("a_reply_delivered_twice_counts_once", () => {
  const seen = { counted: new Set<string>(), gone: new Set<string>() };
  const reply = { id: "x", parentId: "r" };
  assert.equal(replyDelta(reply, "created", seen), 1);
  assert.equal(replyDelta(reply, "created", seen), 0);
});

test("a_deleted_reply_counts_down_once_and_an_edit_changes_nothing", () => {
  const seen = { counted: new Set<string>(), gone: new Set<string>() };
  assert.equal(replyDelta({ id: "x", parentId: "r" }, "updated", seen), 0);
  assert.equal(replyDelta({ id: "x", parentId: "r", deleted: true }, "deleted", seen), -1);
  assert.equal(replyDelta({ id: "x", parentId: "r", deleted: true }, "updated", seen), 0);
  assert.equal(replyDelta({ id: "y" }, "created", seen), 0);
});
