import { test } from "node:test";
import assert from "node:assert/strict";

import { PreviewBlocked, partitionByPreview, registrationTargets, requireNoPreview } from "../src/push/previewGuard.ts";

const a = { id: "a", previewing: false };
const b = { id: "b", previewing: true };
const previewing = (c: { previewing: boolean }) => c.previewing;

test("turning_notifications_on_is_refused_while_an_instance_previews", () => {
  assert.throws(() => registrationTargets([a, b], previewing, true), PreviewBlocked);
});

test("a_launch_registration_skips_the_previewing_instance_and_keeps_the_others", () => {
  assert.deepEqual(registrationTargets([a, b], previewing, false), [a]);
  assert.deepEqual(registrationTargets([a], previewing, true), [a]);
});

test("turning_notifications_off_is_refused_while_an_instance_previews", () => {
  assert.throws(() => requireNoPreview([a, b], previewing), PreviewBlocked);
  assert.doesNotThrow(() => requireNoPreview([a], previewing));
});

test("nothing_is_registered_when_every_instance_previews_at_launch", () => {
  assert.deepEqual(registrationTargets([b], previewing, false), []);
});

test("the_inbox_marks_only_the_instances_that_do_not_preview", () => {
  assert.deepEqual(partitionByPreview([a, b], previewing), { free: [a], previewing: [b] });
  assert.deepEqual(partitionByPreview([], previewing), { free: [], previewing: [] });
});
