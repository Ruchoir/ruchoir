import { test } from "node:test";
import assert from "node:assert/strict";

import {
  answer,
  enqueue,
  enqueueVersion,
  markDone,
  markFailed,
  markSending,
  markSent,
  nextQuestion,
  nextToSend,
  progress,
  retry,
  type Existing,
  type QueueItem,
} from "../src/logic/uploadQueue.ts";

const target = { spaceId: "s1", folderId: "f1" };
const file = (name: string, size = 100) => ({ uri: `file:///${name}`, name, mime: "image/jpeg", size });
const keys = () => {
  let n = 0;
  return () => `k${++n}`;
};
const names = (q: QueueItem[]) => q.map((i) => i.name);
const states = (q: QueueItem[]) => q.map((i) => i.state);

test("free_names_go_at_once", () => {
  const q = enqueue([], [file("b.pdf")], target, [{ id: "e1", name: "a.pdf", manage: true }], keys());
  assert.deepEqual(states(q), ["waiting"]);
  assert.deepEqual(names(q), ["b.pdf"]);
  assert.equal(nextQuestion(q), undefined);
});

test("taken_names_ask_case_insensitively", () => {
  const q = enqueue([], [file("devis.pdf")], target, [{ id: "e1", name: "Devis.PDF", manage: true }], keys());
  assert.deepEqual(states(q), ["asking"]);
  assert.equal(nextQuestion(q)?.key, "k1");
  // Another folder of the same space does not collide.
  const elsewhere = enqueue(q, [file("devis.pdf")], { spaceId: "s1" }, [], keys());
  assert.equal(elsewhere[1].state, "waiting");
});

test("keep_both_names_stay_free_among_the_queue", () => {
  const existing: Existing[] = [{ id: "e1", name: "img_1.JPG", manage: true }];
  let q = enqueue([], [file("IMG_1.jpg"), file("IMG_1.jpg"), file("IMG_1.jpg")], target, existing, keys());
  assert.deepEqual(states(q), ["asking", "asking", "asking"]);
  q = answer(q, "k1", "keepBoth", true, existing);
  assert.deepEqual(names(q), ["IMG_1 (1).jpg", "IMG_1 (2).jpg", "IMG_1 (3).jpg"]);
  assert.deepEqual(states(q), ["waiting", "waiting", "waiting"]);
});

test("replace_targets_the_existing_file", () => {
  const existing: Existing[] = [{ id: "e1", name: "Devis.pdf", manage: true }];
  const q = answer(enqueue([], [file("devis.pdf")], target, existing, keys()), "k1", "replace", false, existing);
  assert.equal(q[0].replaceFileId, "e1");
  assert.equal(q[0].name, "Devis.pdf");
  assert.equal(q[0].state, "waiting");
});

test("replace_falls_back_without_rights", () => {
  const existing: Existing[] = [{ id: "e1", name: "Devis.pdf", manage: false }];
  const q = answer(enqueue([], [file("devis.pdf")], target, existing, keys()), "k1", "replace", false, existing);
  assert.equal(q[0].replaceFileId, undefined);
  assert.equal(q[0].name, "devis (1).pdf");
});

test("skip_drops_the_item", () => {
  const existing: Existing[] = [{ id: "e1", name: "a.pdf", manage: true }];
  const q = answer(enqueue([], [file("a.pdf"), file("b.pdf")], target, existing, keys()), "k1", "skip", false, existing);
  assert.deepEqual(names(q), ["b.pdf"]);
});

test("for_all_answers_the_others", () => {
  const existing: Existing[] = [
    { id: "e1", name: "a.pdf", manage: true },
    { id: "e2", name: "b.pdf", manage: true },
  ];
  const picked = [file("a.pdf"), file("b.pdf")];
  const one = answer(enqueue([], picked, target, existing, keys()), "k1", "skip", false, existing);
  assert.deepEqual(states(one), ["asking"]);
  const all = answer(enqueue([], picked, target, existing, keys()), "k1", "skip", true, existing);
  assert.deepEqual(all, []);
});

test("retry_resends_once", () => {
  let q = enqueue([], [file("a.pdf")], target, [], keys());
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
  let q = enqueue([], [file("a.pdf", 100), file("b.pdf", 300)], target, [], keys());
  q = markSent(markSending(q, "k1"), "k1", 50);
  assert.deepEqual(progress(q), { count: 2, sent: 50, total: 400, failed: 0 });
  q = markDone(q, "k1");
  q = markFailed(markSending(q, "k2"), "k2", "tooLarge");
  assert.deepEqual(progress(q), { count: 1, sent: 0, total: 0, failed: 1 });
});
