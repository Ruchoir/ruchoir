import { test } from "node:test";
import assert from "node:assert/strict";

import { parseInline, plainExcerpt } from "../src/logic/inline.ts";

const NAMES = ["Camille", "Camille Roux", "Léa"];

test("a_mention_is_its_own_segment", () => {
  assert.deepEqual(parseInline("@Camille, tu peux confirmer", NAMES), [
    { kind: "mention", text: "@Camille" },
    { kind: "text", text: ", tu peux confirmer" },
  ]);
});

test("the_longest_name_wins", () => {
  assert.deepEqual(parseInline("@Camille Roux ok", NAMES), [
    { kind: "mention", text: "@Camille Roux" },
    { kind: "text", text: " ok" },
  ]);
});

test("an_unknown_handle_stays_text", () => {
  assert.deepEqual(parseInline("écris à @personne", NAMES), [{ kind: "text", text: "écris à @personne" }]);
});

test("bold_italic_and_code", () => {
  assert.deepEqual(parseInline("**gras**, _penché_ et `code`", NAMES), [
    { kind: "bold", text: "gras" },
    { kind: "text", text: ", " },
    { kind: "italic", text: "penché" },
    { kind: "text", text: " et " },
    { kind: "code", text: "code" },
  ]);
});

test("a_link_stops_before_trailing_punctuation", () => {
  assert.deepEqual(parseInline("voir https://a.test/x.", NAMES), [
    { kind: "text", text: "voir " },
    { kind: "link", text: "https://a.test/x" },
    { kind: "text", text: "." },
  ]);
});

test("an_excerpt_is_one_plain_line", () => {
  assert.equal(plainExcerpt("**Bonjour** à `tous`\n\n> ligne 2"), "Bonjour à tous ligne 2");
});
