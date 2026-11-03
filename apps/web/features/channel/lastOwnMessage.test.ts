import { test } from "node:test";
import assert from "node:assert/strict";

import { lastOwnMessage } from "./lastOwnMessage.ts";

const me = { id: "u-me", name: "Lilou" };

test("the_last_message_one_wrote_is_found_from_the_end", () => {
  const list = [
    { id: "1", author: "Lilou", authorId: "u-me" },
    { id: "2", author: "Théo", authorId: "u-theo" },
    { id: "3", author: "Lilou", authorId: "u-me" },
    { id: "4", author: "Théo", authorId: "u-theo" },
  ];
  assert.equal(lastOwnMessage(list, me)?.id, "3");
});

test("system_rows_deleted_messages_and_unsent_ones_are_skipped", () => {
  const list = [
    { id: "1", author: "Lilou", authorId: "u-me" },
    { id: "2", author: "Lilou", authorId: "u-me", deleted: true },
    { id: "3", author: "Lilou", kind: "system" as const },
    { id: "tmp-4", author: "Lilou" },
  ];
  assert.equal(lastOwnMessage(list, me)?.id, "1");
});

test("the_user_id_decides_when_both_sides_have_one", () => {
  // Two people may share a display name: the id tells them apart.
  const list = [
    { id: "1", author: "Lilou", authorId: "u-me" },
    { id: "2", author: "Lilou", authorId: "u-other" },
  ];
  assert.equal(lastOwnMessage(list, me)?.id, "1");
});

test("the_name_decides_for_a_row_without_an_author_id", () => {
  const list = [
    { id: "1", author: "Théo" },
    { id: "2", author: "Lilou" },
  ];
  assert.equal(lastOwnMessage(list, me)?.id, "2");
  assert.equal(lastOwnMessage(list, { id: "", name: "" }), undefined);
});

test("nothing_is_found_when_one_wrote_nothing", () => {
  assert.equal(lastOwnMessage([{ id: "1", author: "Théo", authorId: "u-theo" }], me), undefined);
  assert.equal(lastOwnMessage([], me), undefined);
});
