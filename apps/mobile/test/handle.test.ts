import { test } from "node:test";
import assert from "node:assert/strict";

import { channelHandle, MAX_HANDLE_LEN } from "../src/logic/handle.ts";

// The same cases as the server's `slug.rs`, which this mirrors.
test("folds_accents_and_separators", () => {
  assert.equal(channelHandle("Comptabilité 2026"), "comptabilite-2026");
  assert.equal(channelHandle("  Atelier   Bois  "), "atelier-bois");
  assert.equal(channelHandle("#général"), "general");
  assert.equal(channelHandle("Cœur & Âme"), "coeur-ame");
  assert.equal(channelHandle("Projets clients"), "projets-clients");
});

test("an_already_normalised_handle_is_unchanged", () => {
  assert.equal(channelHandle("veille-marche"), "veille-marche");
});

test("a_name_with_nothing_usable_normalises_to_empty", () => {
  assert.equal(channelHandle("   "), "");
  assert.equal(channelHandle("///"), "");
});

test("a_long_name_is_capped", () => {
  assert.equal(channelHandle("a".repeat(MAX_HANDLE_LEN + 20)).length, MAX_HANDLE_LEN);
});
