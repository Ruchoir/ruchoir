import { test } from "node:test";
import assert from "node:assert/strict";

import { fabCompact, fabStep } from "../src/logic/fab.ts";

test("near_the_top_the_button_is_full", () => {
  assert.equal(fabCompact(true, 300, 10), false);
  assert.equal(fabCompact(false, 0, 20), false);
});

test("scrolling_down_shrinks_it_scrolling_up_brings_it_back", () => {
  assert.equal(fabCompact(false, 100, 140), true);
  assert.equal(fabCompact(true, 400, 360), false);
});

test("a_small_jitter_changes_nothing", () => {
  assert.equal(fabCompact(false, 100, 104), false);
  assert.equal(fabCompact(true, 400, 396), true);
});

test("small_steps_add_up_from_where_the_scroll_turned", () => {
  // A scroll arrives as many small steps (a few points each).
  let state = { compact: false, anchor: 0 };
  for (let y = 0; y <= 60; y += 3) state = fabStep(state, y);
  assert.equal(state.compact, true);
  for (let y = 60; y >= 45; y -= 3) state = fabStep(state, y);
  assert.equal(state.compact, false);
});
