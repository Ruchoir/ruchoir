import { test } from "node:test";
import assert from "node:assert/strict";

import { afterOpen, guardedSwitch } from "./switchGuard.ts";

function spy() {
  const calls: string[] = [];
  return { calls, go: () => calls.push("go"), cancelAll: () => calls.push("cancelAll") };
}

test("switch_waits_for_uploads", async () => {
  // Idle: goes at once, without asking.
  let s = spy();
  let asked = false;
  assert.equal(await guardedSwitch(() => false, async () => ((asked = true), "wait"), s.cancelAll, s.go), true);
  assert.deepEqual(s.calls, ["go"]);
  assert.equal(asked, false);

  // Busy, "wait": nothing happens.
  s = spy();
  assert.equal(await guardedSwitch(() => true, async () => "wait", s.cancelAll, s.go), false);
  assert.deepEqual(s.calls, []);

  // Busy, "cancel": the sends are cancelled, then the switch goes on.
  s = spy();
  assert.equal(await guardedSwitch(() => true, async () => "cancel", s.cancelAll, s.go), true);
  assert.deepEqual(s.calls, ["cancelAll", "go"]);
});

test("opening_another_instance_waits_for_the_switch_instead_of_remounting", () => {
  // The interface remounts by itself when the open instance changes (its key): bumping it as well
  // would mount the old instance at the new instance's address first.
  assert.equal(afterOpen("a", "b"), "await-switch");
  assert.equal(afterOpen("a", "a"), "remount");
  assert.equal(afterOpen(null, "a"), "await-switch");
});
