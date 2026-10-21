// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcileNotifPrefs } from "./notifPrefsSync.ts";

const defaults = { enabled: true, sound: true, quietHours: false };
const mine = { enabled: true, sound: false, quietHours: true };
const theirs = { enabled: false, sound: true, quietHours: false };

test("the_web_takes_the_server_s_unless_it_holds_none", () => {
  assert.deepEqual(reconcileNotifPrefs({ local: mine, server: theirs, defaults, shared: false }), { prefs: theirs, push: false });
  assert.deepEqual(reconcileNotifPrefs({ local: mine, server: defaults, defaults, shared: false }), { prefs: mine, push: true });
});

test("the_desktop_s_own_choice_goes_to_every_instance", () => {
  // Once the person has chosen in the app, the app's settings win and the instance is brought in line.
  assert.deepEqual(reconcileNotifPrefs({ local: mine, server: theirs, defaults, shared: true }), { prefs: mine, push: true });
  // Already in line: nothing to send.
  assert.deepEqual(reconcileNotifPrefs({ local: mine, server: { ...mine }, defaults, shared: true }), { prefs: mine, push: false });
});

test("only_the_known_fields_are_compared", () => {
  const server = { ...mine, utcOffsetMinutes: 120 };
  assert.equal(reconcileNotifPrefs({ local: mine, server, defaults, shared: true }).push, false);
});
