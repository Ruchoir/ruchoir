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
