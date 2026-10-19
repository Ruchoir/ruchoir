import { test } from "node:test";
import assert from "node:assert/strict";

import { FEELS } from "../src/logic/haptics.ts";

test("the_vocabulary_matches_the_spec", () => {
  assert.deepEqual(FEELS.menu, { ios: { kind: "impact", style: "medium" }, android: "long-press" });
  assert.deepEqual(FEELS.choice, { ios: { kind: "selection" }, android: "segment-tick" });
  assert.deepEqual(FEELS.send, { ios: { kind: "impact", style: "medium" }, android: "confirm" });
  assert.deepEqual(FEELS.refresh, { ios: { kind: "impact", style: "medium" }, android: "gesture-end" });
  assert.equal(FEELS.toggleOn.android, "toggle-on");
  assert.equal(FEELS.toggleOff.android, "toggle-off");
});

test("the_switch_is_silent_on_ios", () => {
  // UISwitch plays the system's own haptic: a second one would double it.
  assert.equal(FEELS.toggleOn.ios, null);
  assert.equal(FEELS.toggleOff.ios, null);
});

test("outcomes_use_notifications_on_ios", () => {
  assert.deepEqual(FEELS.success, { ios: { kind: "notification", type: "success" }, android: "confirm" });
  assert.deepEqual(FEELS.failure, { ios: { kind: "notification", type: "error" }, android: "reject" });
  assert.deepEqual(FEELS.warning, { ios: { kind: "notification", type: "warning" }, android: "reject" });
});
