import { test } from "node:test";
import assert from "node:assert/strict";

import { guardDecision, memberDoors } from "../src/logic/sectionGuard.ts";
import { featureState } from "../src/logic/featureState.ts";

test("guard_waits_until_space_and_features_are_known", () => {
  assert.equal(guardDecision({ known: false, ready: true, allowed: false }), "wait");
  assert.equal(guardDecision({ known: true, ready: false, allowed: false }), "wait");
  assert.equal(guardDecision({ known: true, ready: false, allowed: true }), "wait");
});

test("guard_stays_when_allowed_and_leaves_when_not", () => {
  assert.equal(guardDecision({ known: true, ready: true, allowed: true }), "stay");
  assert.equal(guardDecision({ known: true, ready: true, allowed: false }), "leave");
});

test("feature_state_is_undefined_until_the_list_is_known", () => {
  assert.equal(featureState(undefined, "permissions"), undefined);
  assert.equal(featureState([], "permissions"), false);
  assert.equal(featureState(["permissions"], "permissions"), true);
  assert.equal(featureState(["licences"], "permissions"), false);
});

const none = { invite: false, managePeople: false, setDefaultChannel: false };

test("doors_follow_the_permissions_when_supported", () => {
  assert.deepEqual(memberDoors(true, { ...none, invite: true }, true), { invite: true, changeRole: false, defaultChannel: false });
  assert.deepEqual(memberDoors(true, { ...none, managePeople: true, setDefaultChannel: true }, false), { invite: false, changeRole: true, defaultChannel: true });
});

test("doors_follow_the_legacy_role_otherwise", () => {
  assert.deepEqual(memberDoors(false, none, true), { invite: true, changeRole: true, defaultChannel: true });
  assert.deepEqual(memberDoors(false, { ...none, invite: true }, false), { invite: false, changeRole: false, defaultChannel: false });
});
