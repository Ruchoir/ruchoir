import { test } from "node:test";
import assert from "node:assert/strict";

import { EMOJI_CATEGORIES, QUICK_REACTIONS, searchEmojis } from "../src/emoji/index.ts";

test("every_category_has_an_id_an_icon_and_emojis", () => {
  for (const c of EMOJI_CATEGORIES) {
    assert.ok(c.id && c.icon && c.emojis.length > 0, c.id);
  }
  assert.ok(QUICK_REACTIONS.length >= 5);
});

test("search_finds_by_a_word_of_the_readers_language", () => {
  assert.ok(searchEmojis("coeur", "fr").includes("❤️"));
  assert.ok(searchEmojis("Herz", "de").includes("❤️"));
});

test("search_falls_back_to_french_and_english", () => {
  assert.ok(searchEmojis("heart", "pl").includes("❤️"));
});

test("an_empty_query_finds_nothing", () => {
  assert.deepEqual(searchEmojis("  ", "fr"), []);
});
