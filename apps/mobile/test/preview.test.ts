import { test } from "node:test";
import assert from "node:assert/strict";

import {
  backgroundWritesAllowed,
  bannerWords,
  idleExpired,
  idleMs,
  previewEnded,
  previewTransition,
  refusalGate,
  refusedBody,
  refusedSentence,
  topInsetUnderBanner,
} from "../src/logic/preview.ts";

const previewed = { id: "s1", preview: { roleId: "r1", roleName: "Comptable", idleSeconds: 600 } };
const plain = { id: "s1" };

test("background_writes_stop_while_a_space_is_previewed", () => {
  assert.equal(backgroundWritesAllowed(previewed), false);
  assert.equal(backgroundWritesAllowed(plain), true);
});

test("background_writes_are_allowed_when_there_is_no_space_yet", () => {
  assert.equal(backgroundWritesAllowed(null), true);
  assert.equal(backgroundWritesAllowed(undefined), true);
});

test("the_banner_says_the_role_and_the_minutes_of_silence", () => {
  assert.deepEqual(bannerWords(previewed.preview, "Atelier Rennes"), { space: "Atelier Rennes", role: "Comptable", minutes: 10 });
});

test("the_banner_defaults_to_thirty_minutes_when_the_server_does_not_say", () => {
  assert.equal(bannerWords({ roleId: "r1", roleName: "Comptable" }, "Atelier").minutes, 30);
});

test("a_preview_ended_when_the_space_comes_back_without_it", () => {
  assert.equal(previewEnded("r1", plain), true);
  assert.equal(previewEnded("r1", previewed), false);
});

test("a_preview_that_never_started_has_not_ended", () => {
  assert.equal(previewEnded(undefined, plain), false);
  assert.equal(previewEnded("r1", null), false);
});

test("a_preview_replaced_by_another_role_counts_as_ended_for_the_first", () => {
  assert.equal(previewEnded("r2", previewed), true);
});

test("the_refused_write_says_the_shared_sentence_key", () => {
  assert.equal(refusedSentence({ method: "POST", path: "/conversations/c1/messages" }), "preview.readOnlyTitle");
  assert.equal(refusedSentence(undefined), "preview.readOnlyTitle");
});

test("the_failure_toast_of_the_refused_call_stays_quiet_but_not_an_unrelated_one", () => {
  const gate = refusalGate();
  assert.equal(gate.allows(1000, { failure: true, preview: false }), true);
  assert.equal(gate.allows(2000, { failure: true, preview: true }), true);
  // The follow-up of the very same call, a few milliseconds later: the preview already said it.
  assert.equal(gate.allows(2050, { failure: true, preview: false }), false);
  // Only that one: a second failure right after is another matter.
  assert.equal(gate.allows(2060, { failure: true, preview: false }), true);
  assert.equal(gate.allows(2070, { failure: false, preview: false }), true);
});

test("an_unrelated_failure_after_a_refusal_is_shown", () => {
  const gate = refusalGate();
  assert.equal(gate.allows(2000, { failure: true, preview: true }), true);
  assert.equal(gate.allows(3000, { failure: true, preview: false }), true);
});

test("two_refusals_of_one_attempt_speak_once", () => {
  const gate = refusalGate();
  assert.equal(gate.allows(2000, { failure: true, preview: true }), true);
  assert.equal(gate.allows(2100, { failure: true, preview: true }), false);
  assert.equal(gate.allows(3000, { failure: true, preview: true }), true);
});

test("the_refused_toast_has_a_body_line_without_click", () => {
  assert.equal(refusedBody({ method: "POST", path: "/conversations/c1/messages" }), "preview.readOnlyBodySend");
  assert.equal(refusedBody({ method: "PATCH", path: "/me" }), "preview.readOnlyBody");
  assert.equal(refusedBody(undefined), "preview.readOnlyBody");
});

test("changing_space_during_a_preview_quits_the_previous_one_and_announces_nothing", () => {
  const seen = { spaceId: "s1", roleId: "r1" };
  assert.deepEqual(previewTransition(seen, { id: "s2" }), { quitSpaceId: "s1", ended: false });
  assert.deepEqual(previewTransition(seen, { id: "s2", preview: { roleId: "r1", roleName: "x" } }), { quitSpaceId: "s1", ended: false });
});

test("the_same_space_coming_back_without_the_preview_is_an_end", () => {
  const seen = { spaceId: "s1", roleId: "r1" };
  assert.deepEqual(previewTransition(seen, { id: "s1" }), { ended: true });
  assert.deepEqual(previewTransition(seen, { id: "s1", preview: { roleId: "r1", roleName: "x" } }), { ended: false });
  assert.deepEqual(previewTransition(undefined, { id: "s1" }), { ended: false });
  assert.deepEqual(previewTransition(seen, null), { ended: false });
});

test("a_preview_is_idle_after_its_seconds_without_a_touch", () => {
  assert.equal(idleExpired(0, 599_000, 600), false);
  assert.equal(idleExpired(0, 600_000, 600), true);
  assert.equal(idleExpired(10_000, 1_809_999, undefined), false);
  assert.equal(idleExpired(10_000, 1_810_000, undefined), true);
  assert.equal(idleMs(undefined), 1_800_000);
  assert.equal(idleMs(0), 1_800_000);
});

test("the_banner_takes_the_status_bar_so_what_is_under_it_does_not", () => {
  assert.equal(topInsetUnderBanner(47, true), 0);
  assert.equal(topInsetUnderBanner(47, false), 47);
});
