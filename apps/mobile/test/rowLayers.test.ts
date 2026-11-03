import { test } from "node:test";
import assert from "node:assert/strict";

import { rowLayers } from "../src/screens/discussions/rowLayers.ts";

test("a_continued_message_keeps_its_small_top_on_a_tablet", () => {
  // The later layer wins: `continued` (2) must come after `rowTablet` (12), as before the styles.
  const layers = rowLayers({ head: false, tablet: true, card: false, mention: false });
  assert.deepEqual(layers, ["row", "rowTablet", "continued"]);
});

test("a_mention_tints_over_a_card", () => {
  const layers = rowLayers({ head: true, tablet: false, card: true, mention: true });
  assert.deepEqual(layers, ["row", "card", "mention"]);
  assert.deepEqual(rowLayers({ head: false, tablet: true, card: true, mention: true }), ["row", "rowTablet", "card", "mention", "continued"]);
});
