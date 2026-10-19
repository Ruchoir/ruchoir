import { test } from "node:test";
import assert from "node:assert/strict";

import { GRACE_MS, biometryKind, lockOnReturn, usableBiometry } from "../src/logic/lock.ts";

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
});

test("without_enrolled_biometrics_the_lock_is_the_pin_alone", () => {
  // expo-local-authentication's SecurityLevel: 0 none, 1 passcode only, 2 weak and 3 strong biometrics.
  assert.equal(usableBiometry(0, [], "ios"), null);
  assert.equal(usableBiometry(1, [2], "ios"), null, "a Face ID phone where Face ID is not set up");
  assert.equal(usableBiometry(3, [2], "ios"), "faceId");
  assert.equal(usableBiometry(2, [1, 2], "android"), "biometrics");
});

test("paused_biometrics_are_still_offered", () => {
  // Face ID paused after failures: the level drops to the passcode, the phone still has it enrolled.
  assert.equal(usableBiometry(1, [2], "ios", true), "faceId");
  assert.equal(usableBiometry(1, [2], "ios", false), null);
});
