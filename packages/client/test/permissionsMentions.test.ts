import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldMention, matchGroupMention, matchMentionTarget, prepareGroupNames } from "../src/permissionsLogic/index.ts";

test("a_group_name_is_matched_before_a_shorter_person_name", () => {
  const people = ["Chantier", "Camille Martin", "canal"];
  const groups = ["Chantier Rennes", "Comptabilité"];
  const text = "@Chantier Rennes merci";
  assert.deepEqual(matchMentionTarget(text, 1, people, groups), { kind: "group", name: "Chantier Rennes" });
  // The person alone is still the person.
  assert.deepEqual(matchMentionTarget("@Chantier merci", 1, people, groups), { kind: "person", name: "Chantier" });
  // Accents and case are folded, the typed spelling is kept.
  assert.deepEqual(matchMentionTarget("@comptabilite ?", 1, people, groups), { kind: "group", name: "comptabilite" });
  assert.equal(matchMentionTarget("@Inconnu", 1, people, groups), null);
});

test("an_exact_tie_goes_to_the_person", () => {
  assert.deepEqual(matchMentionTarget("@Ops", 1, ["Ops"], ["ops"]), { kind: "person", name: "Ops" });
  // A name that goes on is another word.
  assert.equal(matchGroupMention("@Opsie", 1, ["Ops"]), null);
  assert.equal(matchGroupMention("@Comptable", 1, ["Compta"]), null);
});

test("a_group_mention_ends_at_the_end_of_the_word", () => {
  for (const text of ["@Ops", "@Ops,", "@Ops.", "@Ops merci", "@Ops!"]) {
    assert.equal(matchGroupMention(text, 1, ["Ops"]), "Ops", text);
  }
  assert.equal(matchGroupMention("@Ops-2", 1, ["Ops"]), null);
});

test("a_decomposed_accent_is_not_folded_because_the_server_does_not_fold_it", () => {
  // The server's fold is a fixed Latin table: "e" then a combining mark is not "é" there.
  assert.equal(matchGroupMention("@Comptabilite\u0301 ok", 1, ["Comptabilité"]), null);
  assert.equal(matchGroupMention("@Comptabilité ok", 1, ["Comptabilité"]), "Comptabilité");
  assert.equal(matchGroupMention("@COMPTABILITE ok", 1, ["Comptabilité"]), "COMPTABILITE");
  assert.equal(matchGroupMention("@coeur", 1, ["Cœur"]), "coeur");
});

test("a_group_mention_follows_the_servers_rule", () => {
  // An address is not a mention.
  assert.equal(matchGroupMention("contact@compta.fr", 8, ["Compta"]), null);
  assert.equal(matchGroupMention("jean@ops.fr", 5, ["Ops"]), null);
  // Only trailing . , ; : ! ? belong to the sentence: anything else glued to the name is another word.
  assert.equal(matchGroupMention("(@Ops)", 2, ["Ops"]), null);
  assert.equal(matchGroupMention("@Ops's", 1, ["Ops"]), null);
  assert.equal(matchGroupMention("@Ops.Net", 1, ["Ops"]), null);
  assert.equal(matchGroupMention("a @Ops;", 3, ["Ops"]), "Ops");
  assert.equal(matchGroupMention("a @Ops?", 3, ["Ops"]), "Ops");
  // Whitespace between the words is any run of it.
  assert.equal(matchGroupMention("@Chantier  Rennes ok", 1, ["Chantier Rennes"]), "Chantier  Rennes");
  assert.equal(matchGroupMention("@Chantier\nRennes ok", 1, ["Chantier Rennes"]), "Chantier\nRennes");
  assert.equal(matchGroupMention("@Chantier Rennes, ok", 1, ["Chantier Rennes"]), "Chantier Rennes");
  // After a space or at the start, the @ is a boundary.
  assert.equal(matchGroupMention("salut @Ops", 7, ["Ops"]), "Ops");
});

test("a_surrogate_pair_before_the_at_is_one_handle_character", () => {
  // The server reads code points: "𝒜" (a letter outside the BMP) glued to the @ makes it an address.
  assert.equal(matchGroupMention("\u{1D49C}@Ops", 3, ["Ops"]), null);
  // An emoji is not a handle character: the @ after it is a boundary.
  assert.equal(matchGroupMention("\u{1F600}@Ops", 3, ["Ops"]), "Ops");
});

test("names_with_symbols_and_digits_match_word_by_word", () => {
  assert.equal(matchGroupMention("@R&D Paris ok", 1, ["R&D Paris"]), "R&D Paris");
  assert.equal(matchGroupMention("@Ops (nord) ok", 1, ["Ops (nord)"]), "Ops (nord)");
  assert.equal(matchGroupMention("@Compta 2024/25, merci", 1, ["Compta 2024/25"]), "Compta 2024/25");
});

test("prefix_related_names_pick_the_longest_that_fits", () => {
  const names = ["Ops", "Ops Nord", "Ops Nord Est"];
  assert.equal(matchGroupMention("@Ops Nord Est ok", 1, names), "Ops Nord Est");
  assert.equal(matchGroupMention("@Ops Nord ok", 1, names), "Ops Nord");
  assert.equal(matchGroupMention("@Ops Sud", 1, names), "Ops");
  assert.equal(matchGroupMention("@Ops Nord. Suite", 1, names), "Ops Nord");
});

test("trailing_and_inner_punctuation", () => {
  assert.equal(matchGroupMention("@Ops...", 1, ["Ops"]), "Ops");
  assert.equal(matchGroupMention("@Ops?!", 1, ["Ops"]), "Ops");
  // Inner punctuation belongs to the word: it must match the name's own.
  assert.equal(matchGroupMention("@A.B ok", 1, ["A.B"]), "A.B");
  assert.equal(matchGroupMention("@A,B ok", 1, ["A.B"]), null);
});

test("prepared_names_are_folded_once_and_reused", () => {
  const names = ["Chantier Rennes", "Cœur"];
  const prepared = prepareGroupNames(names);
  assert.deepEqual(prepared.words, [["chantier", "rennes"], ["coeur"]]);
  assert.equal(prepared.maxWords, 2);
  // The same list gives the same structure: it is not recomputed for every message.
  assert.equal(prepareGroupNames(names), prepared);
  assert.equal(matchGroupMention("@coeur", 1, prepared), "coeur");
  assert.equal(foldMention("Cœur"), "coeur");
});

test("the_room_wide_handles_are_offered_only_where_the_person_may_use_them", async () => {
  const { offeredBroadcasts } = await import("../src/permissionsLogic/index.ts");
  const all = [{ name: "canal" }, { name: "ici" }];
  assert.deepEqual(offeredBroadcasts(all, "ca", true), [{ name: "canal" }]);
  assert.deepEqual(offeredBroadcasts(all, "", true), all);
  assert.deepEqual(offeredBroadcasts(all, "", false), []);
  assert.deepEqual(offeredBroadcasts(all, "ca", false), []);
});

test("the_room_wide_handles_are_the_servers", async () => {
  const { ROOM_HANDLES, PRESENT_HANDLES, broadcastMentionNames, foldMention } = await import("../src/permissionsLogic/index.ts");
  const rust = readFileSync(new URL("../../../apps/api/src/messaging/mentions.rs", import.meta.url), "utf8");
  const words = (name: string) => {
    const block = new RegExp(`const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`).exec(rust);
    assert.ok(block, `${name} not found in mentions.rs`);
    return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  assert.deepEqual([...ROOM_HANDLES].sort(), words("CHANNEL_HANDLES").sort());
  assert.deepEqual([...PRESENT_HANDLES].sort(), words("HERE_HANDLES").sort());
  // Every spelling a screen highlights folds to a handle the server knows, accents and l-stroke included.
  const known = new Set<string>([...ROOM_HANDLES, ...PRESENT_HANDLES]);
  const spellings = broadcastMentionNames();
  for (const spelling of ["aquí", "kanał", "ici", "canale"]) assert.ok(spellings.includes(spelling), spelling);
  for (const spelling of spellings) assert.ok(known.has(foldMention(spelling)), spelling);
});

test("the_l_with_a_stroke_is_folded_as_the_server_folds_it", async () => {
  const { foldMention } = await import("../src/permissionsLogic/index.ts");
  assert.equal(foldMention("Kanał"), "kanal");
});

test("a_room_wide_handle_is_found_by_any_word_of_its_kind", async () => {
  const { offeredBroadcasts } = await import("../src/permissionsLogic/index.ts");
  const all = [{ name: "canal" }, { name: "ici" }];
  assert.deepEqual(offeredBroadcasts(all, "Kan", true), [{ name: "canal" }]);
  assert.deepEqual(offeredBroadcasts(all, "tut", true), [{ name: "ici" }]);
  assert.deepEqual(offeredBroadcasts(all, "aqu", true), [{ name: "ici" }]);
  assert.deepEqual(offeredBroadcasts(all, "zzz", true), []);
});
