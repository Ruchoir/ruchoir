import assert from "node:assert/strict";
import { test } from "node:test";
import { matchGroupMention, matchMentionTarget } from "./mentionMatch.ts";

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

test("a_decomposed_accent_matches_and_the_typed_length_is_kept", () => {
  const typed = "Comptabilite\u0301";
  assert.equal(matchGroupMention(`@${typed} ok`, 1, ["Comptabilité"]), typed);
});
