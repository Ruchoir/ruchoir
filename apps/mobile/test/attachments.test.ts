import { test } from "node:test";
import assert from "node:assert/strict";

import { sendPlan, splitBySize } from "../src/logic/attachments.ts";

const f = (name: string, size?: number) => ({ name, size });

test("a_file_over_the_limit_is_refused_by_name", () => {
  const { accepted, refused } = splitBySize([f("a.jpg", 10), f("film.mov", 500), f("b.pdf", 100)], 100);
  assert.deepEqual(accepted.map((x) => x.name), ["a.jpg", "b.pdf"]);
  assert.deepEqual(refused.map((x) => x.name), ["film.mov"]);
});

test("an_unknown_limit_or_size_lets_the_server_decide", () => {
  assert.equal(splitBySize([f("a", 500)], undefined).refused.length, 0);
  assert.equal(splitBySize([f("a")], 100).refused.length, 0);
});

test("with_the_right_to_attach_the_files_go_with_the_text", () => {
  assert.deepEqual(sendPlan({ canAttach: true, body: "", pending: 2, waiting: false }), { ready: true, withFiles: true, blocked: false });
  assert.deepEqual(sendPlan({ canAttach: true, body: "x", pending: 0, waiting: true }), { ready: false, withFiles: true, blocked: false });
});

test("a_lost_right_to_attach_keeps_the_chips_but_sends_only_the_text", () => {
  // Marked, not sent: the person is told, never refused silently by the server.
  assert.deepEqual(sendPlan({ canAttach: false, body: "hello", pending: 2, waiting: false }), { ready: true, withFiles: false, blocked: true });
  // Only files left: nothing to send, and the sentence says why.
  assert.deepEqual(sendPlan({ canAttach: false, body: "", pending: 2, waiting: false }), { ready: false, withFiles: false, blocked: true });
  // An upload still running does not hold back a text that will go without it.
  assert.deepEqual(sendPlan({ canAttach: false, body: "hello", pending: 1, waiting: true }), { ready: true, withFiles: false, blocked: true });
});
