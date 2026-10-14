import { test } from "node:test";
import assert from "node:assert/strict";

import { activeToken, broadcastsFor, insertToken, matchPeople } from "../src/logic/mentions.ts";

test("a_mention_starts_at_the_beginning_or_after_a_space", () => {
  assert.deepEqual(activeToken("@Lé", 3), { kind: "@", query: "Lé", start: 0 });
  assert.deepEqual(activeToken("Bonjour @lea", 12), { kind: "@", query: "lea", start: 8 });
  assert.deepEqual(activeToken("Bonjour @", 9), { kind: "@", query: "", start: 8 });
});

test("an_at_sign_inside_a_word_or_an_email_is_not_a_mention", () => {
  assert.equal(activeToken("ecris a lea@atelier", 19), null);
  assert.equal(activeToken("prix@", 5), null);
});

test("a_hash_suggests_channels_but_not_a_heading", () => {
  assert.deepEqual(activeToken("voir #proj", 10), { kind: "#", query: "proj", start: 5 });
  assert.equal(activeToken("## Titre", 2), null);
});

test("the_token_ends_at_a_space_and_follows_the_cursor", () => {
  assert.equal(activeToken("@Léa ", 5), null);
  assert.deepEqual(activeToken("@Léa et @Hu plus loin", 11), { kind: "@", query: "Hu", start: 8 });
});

test("inserting_replaces_the_token_and_adds_a_space", () => {
  const token = activeToken("Merci @lé", 9)!;
  assert.deepEqual(insertToken("Merci @lé", token, "Léa Martin"), { text: "Merci @Léa Martin ", cursor: 18 });
});

test("inserting_in_the_middle_keeps_the_rest_without_doubling_the_space", () => {
  const token = activeToken("Merci @lé pour tout", 9)!;
  assert.deepEqual(insertToken("Merci @lé pour tout", token, "Léa"), { text: "Merci @Léa pour tout", cursor: 11 });
});

test("suggestions_ignore_accents_and_case_and_stop_at_five", () => {
  const people = ["Léa Martin", "Hugo Lefèvre", "Sophie Léon", "Lea Roux", "Léo Petit", "Paul Lebrun", "Ana Lemaire"].map((name) => ({ name }));
  const found = matchPeople(people, "LE").map((p) => p.name);
  assert.equal(found.length, 5);
  assert.ok(found.includes("Léa Martin") && found.includes("Lea Roux"));
});

test("names_starting_with_the_query_come_first", () => {
  const people = [{ name: "Hugo Lefèvre" }, { name: "Léa Martin" }, { name: "Hélène Dalle" }];
  assert.deepEqual(matchPeople(people, "le").map((p) => p.name), ["Léa Martin", "Hugo Lefèvre", "Hélène Dalle"]);
});

test("the_broadcasts_are_offered_by_their_beginning", () => {
  assert.deepEqual(broadcastsFor(""), ["canal", "ici"]);
  assert.deepEqual(broadcastsFor("ca"), ["canal"]);
  assert.deepEqual(broadcastsFor("lé"), []);
});
