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
  assert.equal(matchGroupMention("@Opsie", 1, ["Ops"]), "Ops");
});
