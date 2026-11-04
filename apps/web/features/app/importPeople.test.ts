import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { blockView, capNames, fallbackSentence, peopleLines, seatsView, startDisabled, viewFromPlan, viewFromSummary } from "./importPeople.ts";

const dict = (locale: string) =>
  JSON.parse(readFileSync(new URL(`../../lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, Record<string, string>>;

/** The French dictionary behind a minimal translator: plural suffixes and {{name}} holes. */
function frT() {
  const fr = dict("fr");
  return (name: string, vars: Record<string, string | number> = {}) => {
    const [group, leaf] = name.split(".");
    const count = typeof vars.count === "number" ? vars.count : undefined;
    const raw = (count !== undefined ? fr[group][`${leaf}_${count === 1 ? "one" : "other"}`] : undefined) ?? fr[group][leaf];
    assert.ok(raw, `missing key ${name}`);
    return raw.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k]));
  };
}

const full = {
  administrators: 3,
  guests: 2,
  moderators: 4,
  groups: 5,
  groupNames: ["Comptabilité", "Communication", "Chantier Rennes", "Direction", "Bureau d'études"],
  customRoles: 0,
  fallbacks: [],
  alreadyHere: [],
  alreadyHereTotal: 0,
  seats: [{ space: "Atelier Dupont", used: 1, incoming: 11, total: 25, over: false }],
};

test("copy_follows_the_source", () => {
  const key = (source: string) => peopleLines(viewFromPlan(full), source, null).find((l) => l.kind === "admins")?.bodyKey;
  assert.equal(key("slack"), "import.peopleAdminsSlack");
  assert.equal(key("teams"), "import.peopleAdminsTeams");
  assert.equal(key("mattermost"), "import.peopleAdminsMattermost");
  assert.equal(key("nextcloud"), "import.peopleAdminsOther");
});

test("no_line_for_a_zero_count", () => {
  const lines = peopleLines(viewFromPlan({ ...full, guests: 0, moderators: 0, groups: 0, groupNames: [] }), "mattermost", null);
  assert.deepEqual(lines.map((l) => l.kind), ["admins"]);
  assert.deepEqual(peopleLines(viewFromPlan({ ...full, administrators: 0, guests: 0, moderators: 0, groups: 0 }), "slack", null), []);
});

test("the_owner_line_names_who_stays_owner", () => {
  const named = peopleLines(viewFromPlan(full), "mattermost", "Camille Martin").find((l) => l.kind === "admins");
  assert.equal(named?.ownerKey, "import.peopleOwnerNamed");
  assert.equal(named?.ownerName, "Camille Martin");
  const unnamed = peopleLines(viewFromPlan(full), "mattermost", null).find((l) => l.kind === "admins");
  assert.equal(unnamed?.ownerKey, "import.peopleOwnerNobody");
});

test("over_seats_disables_start_and_counts_the_missing_place", () => {
  const over = { space: "Atelier Dupont", used: 5, incoming: 21, total: 25, over: true };
  const view = seatsView({ space: over.space, usedBefore: over.used, added: over.incoming, total: over.total });
  assert.equal(view.tone, "over");
  assert.equal(view.missing, 1);
  assert.equal(view.left, 20);
  assert.equal(startDisabled(viewFromPlan({ ...full, seats: [over] })), true);
  const ok = seatsView({ space: "A", usedBefore: 1, added: 11, total: 25 });
  assert.equal(ok.tone, "ok");
  assert.equal(ok.free, 13);
  assert.equal(ok.missing, 0);
  assert.equal(startDisabled(viewFromPlan(full)), false);
});

test("no_seats_line_for_a_created_space", () => {
  // P1: a created space has no licence, so the plan sends no line and the block draws none.
  const created = { ...full, seats: [] };
  assert.equal(viewFromPlan(created).seats.length, 0);
  assert.equal(startDisabled(viewFromPlan(created)), false);
});

test("a_fallback_sentence_names_the_fixed_role", () => {
  const t = frT();
  assert.equal(
    fallbackSentence({ role: "Comptable", fixed: "member", people: 2 }, t),
    "Rôle « Comptable » ramené à Membre (édition communautaire), 2 personnes",
  );
  assert.equal(
    fallbackSentence({ role: "Responsable chantier", fixed: "member", people: 1 }, t),
    "Rôle « Responsable chantier » ramené à Membre (édition communautaire), 1 personne",
  );
});

test("a_fallback_is_said_per_space_with_its_fixed_role", () => {
  const t = frT();
  const view = viewFromSummary({
    administrators: 0, guests: 0, moderators: 0, groups: 0, groupNames: [], kept: 0, keptNames: [], customRoles: 0, seats: [],
    fallbacks: [
      { space: "Atelier Dupont", roleName: "Comptable", fixed: "member", people: 2 },
      { space: "Bureau Rennes", roleName: "Chef de chantier", fixed: "admin", people: 1 },
    ],
  });
  const line = peopleLines(view, "mattermost", null).find((l) => l.kind === "fallbacks");
  assert.ok(line);
  const sentences = line.fallbacks.map((f) => fallbackSentence(f, t));
  assert.equal(sentences[0], "Rôle « Comptable » ramené à Membre dans Atelier Dupont (édition communautaire), 2 personnes");
  assert.equal(sentences[1], "Rôle « Chef de chantier » ramené à Administrateur dans Bureau Rennes (édition communautaire), 1 personne");
  assert.equal(line.titleKey, "import.peopleFallbacksMixed");
});

test("names_are_capped_with_et_n_autres", () => {
  assert.deepEqual(capNames(["a", "b", "c", "d", "e"], 3), { shown: ["a", "b", "c"], more: 2 });
  assert.deepEqual(capNames(["a", "b"], 3), { shown: ["a", "b"], more: 0 });
  // The server lists the first names only: the total is what counts for "et N autres".
  assert.deepEqual(capNames(["a", "b", "c", "d", "e"], 3, 9), { shown: ["a", "b", "c"], more: 6 });
});

const NEW_PREFIXES = [/^import\.(people|fallback|seats)/, /^members\.import/, /^audit\.import/, /^guests\.createdByImport$/, /^groups\.importedFrom$/];
const flat = (d: Record<string, Record<string, string>>) =>
  Object.entries(d).flatMap(([g, leaves]) => Object.entries(leaves).map(([k, v]) => [`${g}.${k}`, v] as const));

test("every_new_string_exists_in_six_locales", () => {
  const fr = flat(dict("fr")).filter(([k]) => NEW_PREFIXES.some((re) => re.test(k)));
  assert.ok(fr.length > 40, `the new strings are found (${fr.length})`);
  for (const locale of ["en", "de", "es", "it", "pl"]) {
    const other = new Map(flat(dict(locale)));
    for (const [k] of fr) assert.ok(other.get(k)?.trim(), `${locale} lacks ${k}`);
  }
});

test("no_string_uses_tu_in_french_nor_a_gendered_wording", () => {
  const fr = flat(dict("fr")).filter(([k]) => NEW_PREFIXES.some((re) => re.test(k)));
  for (const [k, v] of fr) {
    assert.ok(!/\b(tu|toi|ton|ta|tes|ils|elles?)\b/i.test(v), `${k} reads as tu or gendered: ${v}`);
    assert.ok(!/\(e\)|\(s\)|·e\b|\.e\.|é\.e/.test(v), `${k} uses an inclusive hack: ${v}`);
    assert.ok(!v.includes("—"), `${k} has an em dash`);
  }
  for (const locale of ["en", "de", "es", "it", "pl"]) {
    for (const [k, v] of flat(dict(locale)).filter(([k]) => NEW_PREFIXES.some((re) => re.test(k)))) {
      assert.ok(!v.includes("—"), `${locale} ${k} has an em dash`);
    }
  }
});

// --- the block (Task 14): what each frame of the mockups holds ---------------------------------------

const frame1 = full;
const frame2 = { ...full, administrators: 3, guests: 2, seats: [{ space: "Atelier Dupont", used: 5, incoming: 21, total: 25, over: true }] };
const frame3 = {
  ...full, administrators: 2, guests: 1, moderators: 0, groups: 3, groupNames: ["Comptabilité", "Communication", "Chantier Rennes"], seats: [],
  fallbacks: [{ role: "Comptable", fixed: "member" as const, people: 2 }, { role: "Responsable chantier", fixed: "member" as const, people: 1 }],
};
const frame4 = { ...full, seats: [{ space: "Atelier Dupont", used: 8, incoming: 8, total: 25, over: false }], alreadyHere: ["Camille Martin", "Sophie Leroy", "Karim Benali"], alreadyHereTotal: 4 };
const frame8 = { ...full, moderators: 0, groups: 0, groupNames: [], administrators: 2, guests: 1, seats: [{ space: "Atelier Dupont", used: 1, incoming: 7, total: 25, over: false }] };

test("the_block_lists_only_the_rows_with_something", () => {
  assert.deepEqual(blockView(viewFromPlan(frame1), "mattermost", "Camille Martin")?.lines.map((l) => l.kind), ["admins", "guests", "moderators", "groups"]);
  assert.deepEqual(blockView(viewFromPlan(frame4), "mattermost", null)?.lines.map((l) => l.kind), ["admins", "guests", "moderators", "groups", "kept"]);
});

test("frame_1_rows_and_seats_line", () => {
  const b = blockView(viewFromPlan(frame1), "mattermost", "Camille Martin");
  assert.ok(b);
  assert.deepEqual(b.lines.map((l) => l.count), [3, 2, 4, 5]);
  assert.deepEqual(b.lines[3].names, ["Comptabilité", "Communication", "Chantier Rennes"]);
  assert.equal(b.lines[3].more, 2);
  assert.equal(b.seats.length, 1);
  assert.equal(b.seats[0].usedAfter, 12);
  assert.equal(b.seats[0].total, 25);
  assert.equal(b.seats[0].free, 13);
  assert.equal(b.seats[0].usedBefore, 1);
  assert.equal(b.seats[0].added, 11);
  assert.equal(b.over, false);
});

test("frame_2_is_red_and_lancer_is_disabled", () => {
  const view = viewFromPlan(frame2);
  const b = blockView(view, "mattermost", "Camille Martin");
  assert.ok(b);
  assert.equal(b.over, true);
  assert.equal(b.missing, 1);
  assert.equal(b.seats[0].left, 20);
  assert.equal(b.seats[0].added, 21);
  assert.equal(startDisabled(view), true);
});

test("frame_3_fallback_rows_and_pricing_link", () => {
  const b = blockView(viewFromPlan(frame3), "mattermost", null);
  assert.ok(b);
  const line = b.lines.find((l) => l.kind === "fallbacks");
  assert.equal(line?.count, 2);
  assert.equal(line?.titleKey, "import.peopleFallbacksMember");
  assert.equal(b.pricing, true);
  assert.equal(b.seats.length, 0, "no seats line in community edition");
  assert.equal(blockView(viewFromPlan(frame1), "mattermost", null)?.pricing, false);
});

test("frame_4_kept_row_with_names", () => {
  const b = blockView(viewFromPlan(frame4), "mattermost", null);
  const kept = b?.lines.find((l) => l.kind === "kept");
  assert.equal(kept?.count, 4);
  assert.deepEqual(kept?.names, ["Camille Martin", "Sophie Leroy", "Karim Benali"]);
  assert.equal(kept?.more, 1);
  assert.equal(b?.seats[0].usedAfter, 16);
  assert.equal(b?.seats[0].free, 9);
});

test("frame_8_slack_shows_two_rows", () => {
  const b = blockView(viewFromPlan(frame8), "slack", "Camille Martin");
  assert.deepEqual(b?.lines.map((l) => l.kind), ["admins", "guests"]);
  assert.equal(b?.lines[0].bodyKey, "import.peopleAdminsSlack");
  assert.equal(b?.seats[0].usedAfter, 8);
});

test("the_block_is_absent_when_the_archive_has_no_people", () => {
  assert.equal(blockView(viewFromPlan({ ...full, administrators: 0, guests: 0, moderators: 0, groups: 0, groupNames: [], seats: [] }), "slack", null), null);
  assert.equal(blockView(null, "slack", null), null);
});
