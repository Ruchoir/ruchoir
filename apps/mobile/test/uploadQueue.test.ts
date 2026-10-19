import { test } from "node:test";
import assert from "node:assert/strict";

import type { SpaceFile, UploadDuplicate } from "@ruchoir/client";

import {
  answer,
  choicesFor,
  enqueue,
  enqueueVersion,
  markDone,
  markDuplicate,
  markFailed,
  markSending,
  markSent,
  nextQuestion,
  nextToSend,
  progress,
  progressDue,
  retry,
  type QueueItem,
} from "../src/logic/uploadQueue.ts";

const target = { spaceId: "s1", folderId: "f1" };
const file = (name: string, size = 100) => ({ uri: `file:///${name}`, name, mime: "image/jpeg", size });
const keys = () => {
  let n = 0;
  return () => `k${++n}`;
};
const states = (q: QueueItem[]) => q.map((i) => i.state);
const duplicate = (reason: UploadDuplicate["reason"], name = "Devis.pdf"): UploadDuplicate => ({
  reason,
  existing: { id: "e1", name } as SpaceFile,
  path: ["Clients"],
});

test("every_picked_file_waits_its_turn", () => {
  // The server finds duplicates, against the whole space: nothing asks before going.
  const q = enqueue([], [file("a.pdf"), file("a.pdf")], target, keys());
  assert.deepEqual(states(q), ["waiting", "waiting"]);
  assert.equal(nextQuestion(q), undefined);
});

test("a_refused_duplicate_asks_then_goes_with_its_answer", () => {
  let q = markDuplicate(markSending(enqueue([], [file("devis.pdf")], target, keys()), "k1"), "k1", duplicate("same_file"));
  assert.equal(nextQuestion(q)?.key, "k1");
  q = answer(q, "k1", "replace", false);
  assert.equal(q[0].state, "waiting");
  assert.equal(q[0].answer, "replace");
  assert.equal(q[0].duplicate, undefined);
});

test("each_duplicate_offers_what_was_decided", () => {
  assert.deepEqual(choicesFor("same_file"), ["replace", "skip"]);
  assert.deepEqual(choicesFor("same_name"), ["keepBoth", "skip"]);
  assert.deepEqual(choicesFor("same_content"), ["skip"]);
  // A choice not offered skips: the same name with other contents is never replaced.
  const q = markDuplicate(enqueue([], [file("devis.pdf")], target, keys()), "k1", duplicate("same_name"));
  assert.deepEqual(answer(q, "k1", "replace", false), []);
  assert.equal(answer(q, "k1", "keepBoth", false)[0].answer, "keep_both");
});

test("for_all_answers_the_others_of_the_same_reason", () => {
  let q = enqueue([], [file("a.pdf"), file("b.pdf"), file("c.pdf")], target, keys());
  q = markDuplicate(q, "k1", duplicate("same_name", "a.pdf"));
  q = markDuplicate(q, "k2", duplicate("same_name", "b.pdf"));
  q = markDuplicate(q, "k3", duplicate("same_file", "c.pdf"));
  const one = answer(q, "k1", "skip", false);
  assert.deepEqual(states(one), ["asking", "asking"]);
  const all = answer(q, "k1", "keepBoth", true);
  assert.deepEqual(
    all.map((i) => [i.key, i.state, i.answer]),
    [
      ["k1", "waiting", "keep_both"],
      ["k2", "waiting", "keep_both"],
      ["k3", "asking", undefined],
    ],
  );
});

test("retry_resends_once", () => {
  let q = enqueue([], [file("a.pdf")], target, keys());
  assert.equal(nextToSend(q)?.key, "k1");
  q = markSent(markSending(q, "k1"), "k1", 40);
  assert.equal(nextToSend(q), undefined);
  q = markFailed(q, "k1", "network");
  q = retry(q, "k1");
  assert.equal(q[0].state, "waiting");
  assert.equal(q[0].sent, 0);
  assert.equal(q[0].error, undefined);
  // Retrying what is not failed changes nothing, so it is sent once.
  assert.deepEqual(retry(q, "k1"), q);
  q = markSending(q, "k1");
  assert.equal(nextToSend(q), undefined);
});

test("versions_go_as_replacements", () => {
  const q = enqueueVersion([], file("scan.pdf"), target, { id: "e7", name: "Contrat.pdf" }, keys());
  assert.equal(q[0].replaceFileId, "e7");
  assert.equal(q[0].name, "Contrat.pdf");
  assert.equal(q[0].state, "waiting");
});

test("progress_counts_bytes", () => {
  let q = enqueue([], [file("a.pdf", 100), file("b.pdf", 300)], target, keys());
  q = markSent(markSending(q, "k1"), "k1", 50);
  assert.deepEqual(progress(q), { count: 2, sent: 50, total: 400, failed: 0 });
  q = markDone(q, "k1");
  q = markFailed(markSending(q, "k2"), "k2", "tooLarge");
  assert.deepEqual(progress(q), { count: 1, sent: 0, total: 0, failed: 1 });
});

test("progress_is_told_four_times_a_second_at_most", () => {
  assert.equal(progressDue(undefined, 1000), true);
  assert.equal(progressDue(1000, 1100), false);
  assert.equal(progressDue(1000, 1250), true);
});
