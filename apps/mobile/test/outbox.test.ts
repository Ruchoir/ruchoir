import { test } from "node:test";
import assert from "node:assert/strict";

import { arrivedIds, outboxReducer, pendingRows, type OutboxItem } from "../src/logic/outbox.ts";

const ME = { id: "u1", name: "Théo Vilain" };

const item = (over: Partial<OutboxItem>): OutboxItem => ({
  localId: "l1",
  conversationId: "c1",
  body: "Bonjour",
  attachments: [],
  state: "sending",
  createdAt: "2026-10-13T10:00:00.000Z",
  baseline: [],
  ...over,
});

const real = (id: string, body: string, over: Record<string, unknown> = {}) => ({
  id,
  author: ME.name,
  authorId: ME.id,
  body,
  createdAt: "2026-10-13T10:00:01Z",
  ...over,
});

test("a_queued_message_shows_as_sending_in_its_conversation", () => {
  const items = outboxReducer([], { type: "queued", item: item({}) });
  const rows = pendingRows(items, "c1", undefined, ME);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "sending");
  assert.equal(rows[0].message.body, "Bonjour");
  assert.equal(rows[0].message.author, ME.name);
  assert.equal(pendingRows(items, "c2", undefined, ME).length, 0);
});

test("a_thread_reply_shows_in_its_thread_only", () => {
  const items = [item({ localId: "a" }), item({ localId: "b", parentId: "m9" })];
  assert.deepEqual(pendingRows(items, "c1", undefined, ME).map((r) => r.localId), ["a"]);
  assert.deepEqual(pendingRows(items, "c1", "m9", ME).map((r) => r.localId), ["b"]);
});

test("a_sent_message_leaves_the_outbox", () => {
  const items = outboxReducer([item({})], { type: "sent", localId: "l1" });
  assert.deepEqual(items, []);
});

test("a_failed_message_stays_and_can_be_retried", () => {
  let items = outboxReducer([item({})], { type: "failed", localId: "l1" });
  assert.equal(items[0].state, "failed");
  items = outboxReducer(items, { type: "retried", localId: "l1" });
  assert.equal(items[0].state, "sending");
});

test("a_dropped_message_disappears", () => {
  assert.deepEqual(outboxReducer([item({}), item({ localId: "l2" })], { type: "dropped", localId: "l1" }).map((i) => i.localId), ["l2"]);
});

test("a_message_that_arrived_live_is_not_shown_twice", () => {
  const ids = arrivedIds([item({})], [real("m1", "Bonjour")], ME.id);
  assert.deepEqual([...ids.keys()], ["l1"]);
});

test("a_failed_send_that_reached_the_server_is_recognised_and_not_sent_again", () => {
  const ids = arrivedIds([item({ state: "failed" })], [real("m1", "Bonjour")], ME.id);
  assert.equal(ids.get("l1"), "m1");
});

test("a_message_already_on_screen_before_sending_is_not_taken_for_it", () => {
  const ids = arrivedIds([item({ baseline: ["m0"] })], [real("m0", "Bonjour")], ME.id);
  assert.equal(ids.size, 0);
});

test("two_identical_messages_each_claim_their_own", () => {
  const items = [item({ localId: "a" }), item({ localId: "b" })];
  const ids = arrivedIds(items, [real("m1", "Bonjour")], ME.id);
  assert.deepEqual([...ids.entries()], [["a", "m1"]]);
});

test("someone_elses_identical_message_is_not_mine", () => {
  const ids = arrivedIds([item({})], [real("m1", "Bonjour", { authorId: "u2" })], ME.id);
  assert.equal(ids.size, 0);
});
