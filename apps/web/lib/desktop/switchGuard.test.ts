import { test } from "node:test";
import assert from "node:assert/strict";

import { guardedSwitch } from "./switchGuard.ts";

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
