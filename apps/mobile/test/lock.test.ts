import { test } from "node:test";
import assert from "node:assert/strict";

import { GRACE_MS, biometryKind, lockOnReturn } from "../src/logic/lock.ts";

test("a_quick_look_at_another_app_does_not_lock", () => {
  assert.equal(lockOnReturn(true, 1_000, 1_000 + GRACE_MS - 1), false);
});

test("a_longer_absence_locks", () => {
  assert.equal(lockOnReturn(true, 1_000, 1_000 + GRACE_MS + 1), true);
});

test("nothing_locks_when_the_lock_is_off_or_the_app_never_left", () => {
  assert.equal(lockOnReturn(false, 1_000, 1_000 + 10 * GRACE_MS), false);
  assert.equal(lockOnReturn(true, null, 10 * GRACE_MS), false);
});

test("the_grace_is_one_minute", () => {
  assert.equal(GRACE_MS, 60_000);
});

test("the_biometrics_are_named_as_the_phone_has_them", () => {
  // expo-local-authentication's AuthenticationType: 1 fingerprint, 2 face, 3 iris.
  assert.equal(biometryKind([2], "ios"), "faceId");
  assert.equal(biometryKind([1], "ios"), "touchId");
  assert.equal(biometryKind([1, 2], "android"), "biometrics");
  assert.equal(biometryKind([3], "android"), "biometrics");
  assert.equal(biometryKind([], "ios"), "passcode");
  assert.equal(biometryKind([], "android"), "passcode");
});
