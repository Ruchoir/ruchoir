import { test } from "node:test";
import assert from "node:assert/strict";

import { parseInline } from "../src/logic/inline.ts";
import { activeToken, insertToken } from "../src/logic/mentions.ts";
import { matchGroupMention } from "@ruchoir/client/permissionsLogic";
import { groupByName, mentionOrder, mentionableGroups } from "../src/logic/groupMentions.ts";

const group = (id: string, name: string, memberIds: string[] = []) => ({
  id,
  name,
  source: "manual" as const,
  memberIds,
  managerIds: [],
  roleIds: [],
});

test("a_group_name_parses_as_a_group_mention", () => {
  const segments = parseInline("@Comptabilité pouvez-vous valider ?", ["Julie Moreau"], ["Comptabilité"]);
  assert.deepEqual(segments[0], { kind: "group", text: "@Comptabilité" });
  // Accents and case are folded, as the server reads it; the text stays as typed.
  assert.deepEqual(parseInline("salut @comptabilite !", [], ["Comptabilité"])[1], { kind: "group", text: "@comptabilite" });
});

test("a_group_name_with_spaces_is_one_mention", () => {
  assert.deepEqual(parseInline("@Chantier  Rennes, merci", ["Chantier"], ["Chantier Rennes"])[0], { kind: "group", text: "@Chantier  Rennes" });
});

test("a_person_named_like_a_group_stays_a_person", () => {
  // Same length: the person wins, as on the web.
  assert.deepEqual(parseInline("@Ops ok", ["Ops"], ["ops"])[0], { kind: "mention", text: "@Ops" });
  // The longer name wins: the group "Chantier Rennes" beats the person "Chantier".
  assert.deepEqual(parseInline("@Chantier Rennes ok", ["Chantier"], ["Chantier Rennes"])[0], { kind: "group", text: "@Chantier Rennes" });
  assert.deepEqual(parseInline("@Chantier merci", ["Chantier"], ["Chantier Rennes"])[0], { kind: "mention", text: "@Chantier" });
});

test("a_group_mention_follows_the_servers_rule", () => {
  assert.equal(matchGroupMention("contact@compta.fr", 8, ["Compta"]), null);
  assert.equal(matchGroupMention("@Opsie", 1, ["Ops"]), null);
  assert.equal(matchGroupMention("a @Ops?", 3, ["Ops"]), "Ops");
  assert.equal(parseInline("jean@ops.fr", [], ["Ops"]).every((s) => s.kind === "text"), true);
});

test("without_groups_a_line_reads_as_before", () => {
  assert.deepEqual(parseInline("@Léa bonjour", ["Léa"]), [{ kind: "mention", text: "@Léa" }, { kind: "text", text: " bonjour" }]);
});

test("a_group_is_found_by_its_name_as_a_tap_gives_it", () => {
  const groups = [group("g1", "Comptabilité"), group("g2", "Chantier Rennes")];
  assert.equal(groupByName(groups, "@comptabilite")?.id, "g1");
  assert.equal(groupByName(groups, "@Chantier  Rennes")?.id, "g2");
  assert.equal(groupByName(groups, "@Inconnu"), undefined);
});

test("suggestions_put_the_group_before_the_people_and_cap_the_total", () => {
  const hits = mentionOrder({ rooms: ["r"], groups: ["g1", "g2"], people: ["p1", "p2", "p3"] }, 5);
  assert.deepEqual(hits.map((h) => h.item), ["r", "g1", "g2", "p1", "p2"]);
  assert.deepEqual(hits.map((h) => h.kind), ["room", "group", "group", "person", "person"]);
});

test("a_guest_is_offered_no_group_and_a_name_begins_the_match", () => {
  const groups = [group("g1", "Comptabilité", ["a", "b", "c"]), group("g2", "Direction")];
  assert.deepEqual(mentionableGroups("guest", groups, "c").map((h) => h.group.id), []);
  const found = mentionableGroups("member", groups, "compt");
  assert.deepEqual(found.map((h) => [h.group.id, h.members]), [["g1", 3]]);
});

test("a_group_is_inserted_as_the_web_inserts_it", () => {
  const token = activeToken("Bonjour @Compt", 14)!;
  assert.deepEqual(insertToken("Bonjour @Compt", token, "Comptabilité"), { text: "Bonjour @Comptabilité ", cursor: 22 });
});

test("a_group_name_with_spaces_keeps_the_token_open_while_it_begins_a_name", () => {
  const names = ["Chantier Rennes"];
  const token = activeToken("Salut @Chantier Re", 18, names)!;
  assert.deepEqual(token, { kind: "@", query: "Chantier Re", start: 6 });
  assert.equal(insertToken("Salut @Chantier Re", token, "Chantier Rennes").text, "Salut @Chantier Rennes ");
  // A word that does not begin a group's name closes it, as before.
  assert.equal(activeToken("Salut @Chantier Xy", 18, names), null);
  assert.equal(activeToken("Salut @Chantier Re", 18), null);
});

test("a_pill_opens_the_group_the_parser_lit_it_for", () => {
  // The parser folds with the server's table ("coeur" = "Cœur"); the tap must find the same group.
  const groups = [group("g1", "Cœur"), group("g2", "R&D Paris")];
  assert.deepEqual(parseInline("@coeur ok", [], ["Cœur"])[0], { kind: "group", text: "@coeur" });
  assert.equal(groupByName(groups, "@coeur")?.id, "g1");
  assert.equal(groupByName(groups, "@r&d  paris")?.id, "g2");
});

test("names_with_symbols_digits_and_prefixes_parse_as_one_mention", () => {
  const names = ["R&D Paris", "Ops (nord)", "Compta 2024/25", "Ops", "Ops Nord"];
  assert.deepEqual(parseInline("@R&D Paris merci", [], names)[0], { kind: "group", text: "@R&D Paris" });
  assert.deepEqual(parseInline("@Ops (nord), ok", [], names)[0], { kind: "group", text: "@Ops (nord)" });
  assert.deepEqual(parseInline("@Compta 2024/25.", [], names), [{ kind: "group", text: "@Compta 2024/25" }, { kind: "text", text: "." }]);
  assert.deepEqual(parseInline("@Ops Nord ok", [], names)[0], { kind: "group", text: "@Ops Nord" });
  assert.deepEqual(parseInline("@Ops Sud", [], names)[0], { kind: "group", text: "@Ops" });
});
