import { test } from "node:test";
import assert from "node:assert/strict";

import { choiceFor, codeOfStatus, errorText, fileKey, pushSaved, VISIBLE_SAVED } from "./savedFile.ts";

const v = (id: string, current: boolean) => ({ id, number: 1, sizeBytes: 1, createdAt: "", current });

test("the_file_is_sent_when_nobody_added_a_version", () => {
  assert.equal(choiceFor([v("b", true), v("a", false)], "b"), "send");
});

test("the_person_is_asked_when_the_current_version_moved", () => {
  assert.equal(choiceFor([v("c", true), v("b", false)], "b"), "ask");
});

test("the_person_is_asked_when_there_is_no_version_to_compare", () => {
  assert.equal(choiceFor([], "b"), "ask");
});

const s = (file: string, instance = "i1") => ({ instance, file_id: file, name: file, base_version: "x" });

test("a_newer_save_of_the_same_file_replaces_its_banner_and_comes_first", () => {
  const list = pushSaved(pushSaved(pushSaved([], s("a")), s("b")), { ...s("a"), base_version: "y" });
  assert.deepEqual(list.map((x) => x.file_id), ["a", "b"]);
  assert.equal(list[0].base_version, "y");
});

test("the_same_file_id_on_two_instances_is_two_banners", () => {
  assert.notEqual(fileKey(s("a", "i1")), fileKey(s("a", "i2")));
  assert.equal(pushSaved(pushSaved([], s("a", "i1")), s("a", "i2")).length, 2);
});

test("only_three_are_shown_at_most", () => {
  assert.equal(VISIBLE_SAVED, 3);
});

test("every_error_code_has_its_own_words", () => {
  const codes = ["too_large", "busy", "signed_out", "unreachable", "forbidden", "not_watched", "unchanged", "failed", "whatever"];
  const keys = codes.map((c) => errorText(c, (k) => k));
  assert.deepEqual(keys, [
    "desktop.files.saved.tooLarge",
    "desktop.files.saved.busy",
    "desktop.download.signedOut",
    "desktop.download.unreachable",
    "files.uploadForbidden",
    "desktop.files.saved.notWatched",
    "desktop.files.saved.unchanged",
    "desktop.files.saved.failed",
    "desktop.files.saved.failed",
  ]);
});

test("a_refused_read_of_the_versions_is_told_as_it_is", () => {
  assert.equal(codeOfStatus(401), "signed_out");
  assert.equal(codeOfStatus(403), "forbidden");
  assert.equal(codeOfStatus(500), "unreachable");
  assert.equal(codeOfStatus(undefined), "unreachable");
});
