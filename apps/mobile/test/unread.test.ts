import { test } from "node:test";
import assert from "node:assert/strict";

import { countNewer, firstUnreadId } from "../src/logic/unread.ts";

const m = (id: string, authorId: string, kind?: "system") => ({ id, authorId, kind });
const FEED = [m("1", "u2"), m("2", "u1"), m("3", "u2"), m("4", "u3"), m("5", "u1"), m("6", "u2")];

test("no_unread_no_line", () => {
  assert.equal(firstUnreadId(FEED, 0, "u1"), null);
});

test("the_line_sits_above_the_nth_newest_message_from_others", () => {
  assert.equal(firstUnreadId(FEED, 1, "u1"), "6");
  assert.equal(firstUnreadId(FEED, 2, "u1"), "4");
});

test("my_own_messages_and_system_lines_do_not_count", () => {
  const feed = [m("1", "u2"), m("2", "u2"), m("3", "", "system"), m("4", "u1")];
  assert.equal(firstUnreadId(feed, 1, "u1"), "2");
});

test("more_unread_than_loaded_marks_the_oldest_loaded", () => {
  assert.equal(firstUnreadId(FEED, 40, "u1"), "1");
});

test("new_messages_below_count_only_others", () => {
  assert.equal(countNewer(FEED, "3", "u1"), 2);
  assert.equal(countNewer(FEED, "6", "u1"), 0);
});
