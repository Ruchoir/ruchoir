import { test } from "node:test";
import assert from "node:assert/strict";

import { fabCompact } from "../src/logic/fab.ts";

test("at_the_top_the_button_is_full", () => {
  assert.equal(fabCompact(0), false);
  assert.equal(fabCompact(20), false);
  // Pulled down to refresh: still the top.
  assert.equal(fabCompact(-60), false);
});

test("away_from_the_top_it_stays_round", () => {
  assert.equal(fabCompact(140), true);
});

test("scrolling_back_up_or_a_bounce_keeps_it_round", () => {
  // Going up from 900 to 400, or the list bouncing back from its end: still away from the top.
  for (const y of [900, 700, 400, 120]) assert.equal(fabCompact(y), true);
});
