import { test } from "node:test";
import assert from "node:assert/strict";

import { applyReactionDelta, toggleReaction } from "../src/logic/reactions.ts";

const ME = "Théo Vilain";

test("adding_a_new_emoji_creates_my_pill", () => {
  assert.deepEqual(toggleReaction(undefined, "🎉", ME), [{ emoji: "🎉", count: 1, mine: true, users: [ME] }]);
});

test("adding_to_an_existing_pill_counts_me_once", () => {
  const after = toggleReaction([{ emoji: "👍", count: 2, users: ["Léa", "Hugo"] }], "👍", ME);
  assert.deepEqual(after, [{ emoji: "👍", count: 3, mine: true, users: ["Léa", "Hugo", ME] }]);
});

test("removing_mine_lowers_the_count_and_drops_an_empty_pill", () => {
  const two = [{ emoji: "👍", count: 2, mine: true, users: ["Léa", ME] }, { emoji: "🎉", count: 1, mine: true, users: [ME] }];
  assert.deepEqual(toggleReaction(two, "👍", ME), [{ emoji: "👍", count: 1, mine: false, users: ["Léa"] }, two[1]]);
  assert.deepEqual(toggleReaction(two, "🎉", ME), [two[0]]);
});

test("two_quick_taps_end_where_they_started", () => {
  const start = [{ emoji: "👍", count: 2, users: ["Léa", "Hugo"] }];
  const twice = toggleReaction(toggleReaction(start, "👍", ME), "👍", ME);
  assert.deepEqual(twice, [{ emoji: "👍", count: 2, mine: false, users: ["Léa", "Hugo"] }]);
});

test("someone_elses_reaction_adds_their_name", () => {
  const after = applyReactionDelta([{ emoji: "👍", count: 1, mine: true, users: [ME] }], "👍", true, "Léa");
  assert.deepEqual(after, [{ emoji: "👍", count: 2, mine: true, users: [ME, "Léa"] }]);
  assert.deepEqual(applyReactionDelta(undefined, "🎉", true, "Léa"), [{ emoji: "🎉", count: 1, users: ["Léa"] }]);
});

test("someone_elses_removal_drops_an_empty_pill", () => {
  assert.deepEqual(applyReactionDelta([{ emoji: "🎉", count: 1, users: ["Léa"] }], "🎉", false, "Léa"), []);
  const kept = applyReactionDelta([{ emoji: "👍", count: 2, mine: true, users: [ME, "Léa"] }], "👍", false, "Léa");
  assert.deepEqual(kept, [{ emoji: "👍", count: 1, mine: true, users: [ME] }]);
});
