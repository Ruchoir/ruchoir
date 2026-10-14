import { test } from "node:test";
import assert from "node:assert/strict";

import { screenInsets } from "../src/ui/insets.ts";

test("a_full_screen_modal_keeps_the_phones_own_insets", () => {
  // Inside a full-screen modal the live insets can read 0: the phone's own ones still hold.
  assert.deepEqual(screenInsets({ top: 0, bottom: 0 }, { top: 59, bottom: 34 }), { top: 59, bottom: 34 });
  assert.deepEqual(screenInsets({ top: 59, bottom: 34 }, null), { top: 59, bottom: 34 });
  assert.deepEqual(screenInsets({ top: 0, bottom: 0 }, null), { top: 0, bottom: 0 });
});
