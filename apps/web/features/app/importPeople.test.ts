import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { blockView, capNames, doneView, seatsBarLabel, fallbackSentence, peopleLines, seatsView, startDisabled, viewFromPlan, viewFromSummary } from "./importPeople.ts";

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
  const key = (source: string) => peopleLines(viewFromPlan(full), source).find((l) => l.kind === "admins")?.bodyKey;
  assert.equal(key("slack"), "import.peopleAdminsSlack");
  assert.equal(key("teams"), "import.peopleAdminsTeams");
  assert.equal(key("mattermost"), "import.peopleAdminsMattermost");
  assert.equal(key("nextcloud"), "import.peopleAdminsOther");
});

test("no_line_for_a_zero_count", () => {
  const lines = peopleLines(viewFromPlan({ ...full, guests: 0, moderators: 0, groups: 0, groupNames: [] }), "mattermost");
  assert.deepEqual(lines.map((l) => l.kind), ["admins"]);
  assert.deepEqual(peopleLines(viewFromPlan({ ...full, administrators: 0, guests: 0, moderators: 0, groups: 0 }), "slack"), []);
});

const OWNER = { name: "Camille Martin", spaces: ["Atelier Dupont"] };

test("the_owner_line_names_who_stays_owner", () => {
  const named = peopleLines(viewFromPlan(full, OWNER), "mattermost").find((l) => l.kind === "admins");
  assert.deepEqual(named?.owners, [{ name: "Camille Martin", space: "Atelier Dupont" }]);
  // One sentence per space the import created, none for an existing one.
  const two = peopleLines(viewFromPlan(full, { name: "Camille Martin", spaces: ["A", "B"] }), "slack").find((l) => l.kind === "admins");
  assert.deepEqual(two?.owners.map((o) => o.space), ["A", "B"]);
  // Unknown owner, or no created space: the sentence is hidden, never "Personne".
  assert.deepEqual(peopleLines(viewFromPlan(full, null), "mattermost").find((l) => l.kind === "admins")?.owners, []);
  assert.deepEqual(peopleLines(viewFromPlan(full, { name: "Camille Martin", spaces: [] }), "mattermost").find((l) => l.kind === "admins")?.owners, []);
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
  const line = peopleLines(view, "mattermost").find((l) => l.kind === "fallbacks");
  assert.ok(line);
  const sentences = line.fallbacks.map((f) => fallbackSentence(f, t));
  assert.equal(sentences[0], "Rôle « Comptable » ramené à Membre dans l'espace Atelier Dupont (édition communautaire), 2 personnes");
  assert.equal(sentences[1], "Rôle « Chef de chantier » ramené à Administrateur dans l'espace Bureau Rennes (édition communautaire), 1 personne");
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
  assert.deepEqual(blockView(viewFromPlan(frame1, OWNER), "mattermost")?.lines.map((l) => l.kind), ["admins", "guests", "moderators", "groups"]);
  assert.deepEqual(blockView(viewFromPlan(frame4), "mattermost")?.lines.map((l) => l.kind), ["admins", "guests", "moderators", "groups", "kept"]);
});

test("frame_1_rows_and_seats_line", () => {
  const b = blockView(viewFromPlan(frame1, OWNER), "mattermost");
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
  const b = blockView(view, "mattermost");
  assert.ok(b);
  assert.equal(b.over, true);
  assert.equal(b.missing, 1);
  assert.equal(b.seats[0].left, 20);
  assert.equal(b.seats[0].added, 21);
  assert.equal(startDisabled(view), true);
});

test("frame_3_fallback_rows_and_pricing_link", () => {
  const b = blockView(viewFromPlan(frame3), "mattermost");
  assert.ok(b);
  const line = b.lines.find((l) => l.kind === "fallbacks");
  assert.equal(line?.count, 2);
  assert.equal(line?.titleKey, "import.peopleFallbacksMember");
  assert.equal(b.pricing, true);
  assert.equal(b.seats.length, 0, "no seats line in community edition");
  assert.equal(blockView(viewFromPlan(frame1, OWNER), "mattermost")?.pricing, false);
});

test("frame_4_kept_row_with_names", () => {
  const b = blockView(viewFromPlan(frame4), "mattermost");
  const kept = b?.lines.find((l) => l.kind === "kept");
  assert.equal(kept?.count, 4);
  assert.deepEqual(kept?.names, ["Camille Martin", "Sophie Leroy", "Karim Benali"]);
  assert.equal(kept?.more, 1);
  assert.equal(b?.seats[0].usedAfter, 16);
  assert.equal(b?.seats[0].free, 9);
});

test("frame_8_slack_shows_two_rows", () => {
  const b = blockView(viewFromPlan(frame8), "slack");
  assert.deepEqual(b?.lines.map((l) => l.kind), ["admins", "guests"]);
  assert.equal(b?.lines[0].bodyKey, "import.peopleAdminsSlack");
  assert.equal(b?.seats[0].usedAfter, 8);
});

test("the_block_is_absent_when_the_archive_has_no_people", () => {
  assert.equal(blockView(viewFromPlan({ ...full, administrators: 0, guests: 0, moderators: 0, groups: 0, groupNames: [], seats: [] }), "slack"), null);
  assert.equal(blockView(null, "slack"), null);
});

// --- the done screen (Task 15) -----------------------------------------------------------------------

const summary = {
  createdSpaces: ["Atelier Dupont"],
  administrators: 3, guests: 2, moderators: 4, groups: 5,
  groupNames: ["Comptabilité", "Communication", "Chantier Rennes", "Direction", "Bureau d'études"],
  kept: 0, keptNames: [], customRoles: 0, fallbacks: [],
  seats: [{ space: "Atelier Dupont", usedBefore: 1, added: 11, total: 25 }],
};
const LIMITS = ["Les appels et leur historique (Calls) ne sont pas exportés par Mattermost.", "Les réglages de notification de chaque personne ne sont pas exportés."];

test("frame_5_done_shows_what_crossed_and_the_limits_again", () => {
  const done = doneView({ source: "mattermost", people: summary, limits: LIMITS, startedBy: { name: "Camille Martin" } });
  assert.deepEqual(done.block?.lines.map((l) => l.kind), ["admins", "guests", "moderators", "groups"]);
  assert.equal(done.block?.seats[0].usedAfter, 12);
  assert.equal(done.block?.seats[0].free, 13);
  assert.equal(done.block?.over, false);
  assert.deepEqual(done.limits, LIMITS, "the producer's words, in full, in order");
});

test("a_found_again_job_shows_the_same_block_without_a_plan", () => {
  // The screen found the job again: no plan in state, only what the job kept.
  const found = doneView({ source: "mattermost", people: summary, limits: LIMITS, startedBy: { name: "Camille Martin" } });
  const fresh = doneView({ source: "mattermost", people: summary, limits: LIMITS, startedBy: { name: "Camille Martin" } });
  assert.deepEqual(found.block?.lines.map((l) => [l.kind, l.count]), [["admins", 3], ["guests", 2], ["moderators", 4], ["groups", 5]]);
  assert.deepEqual(found, fresh);
  // The owner comes from the job (who started it, which spaces it created), so a reload says it too.
  assert.deepEqual(found.block?.lines[0].owners, [{ name: "Camille Martin", space: "Atelier Dupont" }]);
  const unknown = doneView({ source: "mattermost", people: summary, limits: LIMITS, startedBy: null });
  assert.deepEqual(unknown.block?.lines[0].owners, [], "no name known: the sentence is hidden");
  const filled = doneView({ source: "mattermost", people: { ...summary, createdSpaces: [] }, limits: LIMITS, startedBy: { name: "Camille Martin" } });
  assert.deepEqual(filled.block?.lines[0].owners, [], "no space created: nobody is named");
});

test("a_job_without_a_summary_shows_no_block", () => {
  // An import from before lot 6: no `people` on the job. The limits it kept still show.
  const old = doneView({ source: "slack", people: null, limits: [], startedBy: null });
  assert.equal(old.block, null);
  assert.deepEqual(old.limits, []);
  assert.deepEqual(doneView({ source: "slack", people: null, limits: LIMITS, startedBy: { name: "Camille Martin" } }).limits, LIMITS);
});

// --- review fixes -------------------------------------------------------------------------------------

test("polish_few_forms_take_the_nominative_plural", () => {
  const pl = dict("pl");
  assert.match(pl.import.peopleAdminsTitle_few, /administratorzy/);
  assert.match(pl.import.peopleModsTitle_few, /moderatorzy kanałów/);
  assert.match(pl.import.seatsOverNeeded_few, /miejsca/);
});

test("the_banner_text_has_no_agreement_on_the_figure", () => {
  const bad = /ont été|a été|wurden|wurde|han sido|ha sido|sono stati|were|was /i;
  for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
    const text = dict(locale).members.importBannerText;
    assert.ok(text.includes("{{figures}}") && text.includes("{{source}}"), locale);
    assert.ok(!bad.test(text), `${locale} agrees with the figure: ${text}`);
    assert.ok(text.trimEnd().endsWith("{{figures}}.") || locale === "pl" || /\{\{figures\}\}\.?$/.test(text.trim()), `${locale} ends on the figures`);
  }
  // Rendered with one figure it still reads.
  assert.equal(dict("fr").members.importBannerText.replace("{{source}}", "Slack").replace("{{figures}}", "1 invité"), "Repris de Slack avec leurs droits : 1 invité.");
});

test("the_over_bar_says_what_is_needed_not_what_is_used", () => {
  const over = seatsView({ space: "A", usedBefore: 5, added: 21, total: 25 });
  assert.deepEqual(seatsBarLabel(over), { key: "import.seatsOverNeeded", vars: { count: 26, free: 20 } });
  const ok = seatsView({ space: "A", usedBefore: 1, added: 11, total: 25 });
  assert.deepEqual(seatsBarLabel(ok), { key: "import.seatsUsed", vars: { count: 12, total: "25" } });
});

test("the_pricing_link_has_a_new_tab_name_and_a_fallback_sentence", () => {
  for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
    const d = dict(locale);
    assert.ok(d.import.seatsPricingNewTab?.trim(), `${locale} link name`);
    assert.ok(d.import.seatsNoPricing?.trim(), `${locale} no-pricing sentence`);
  }
});

test("the_owner_and_fallback_sentences_use_the_space_noun_before_a_name", () => {
  const t = frT();
  assert.equal(
    t("import.peopleOwnerNamed", { name: "Camille Martin", space: "Atelier Dupont" }),
    "Camille Martin reste propriétaire de l'espace Atelier Dupont : personne ne le devient par l'import.",
  );
  const noun = { fr: /l'espace \{\{space\}\}/, en: /the space \{\{space\}\}/, de: /Bereichs \{\{space\}\}/, es: /del espacio \{\{space\}\}/, it: /dello spazio \{\{space\}\}/, pl: /przestrzeni \{\{space\}\}/ };
  for (const [locale, re] of Object.entries(noun)) {
    assert.match(dict(locale).import.peopleOwnerNamed, re, locale);
    for (const k of ["fallbackMemberIn_one", "fallbackAdminIn_other"]) {
      assert.ok(!/ (dans|in|en|w) \{\{space\}\}/.test(dict(locale).import[k]), `${locale} ${k} has a bare name after a preposition`);
    }
  }
});
