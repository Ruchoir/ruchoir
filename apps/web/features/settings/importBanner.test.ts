import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { auditLine } from "./auditLogic.ts";
import { chipsFor, guestMadeByImport, importBanner, importedGroupSource, reportLink } from "./importLogic.ts";

const NOW = new Date("2026-11-15T12:00:00");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
const JOB = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const entry = (action: string, daysAgo: number, details: Record<string, unknown> = {}) => ({
  id: `${action}-${daysAgo}`,
  at: at(daysAgo),
  action,
  category: "members",
  actor: { id: "a", name: "Camille Martin" },
  target: { kind: "space" },
  details,
});
const applied = (daysAgo: number, over: Record<string, unknown> = {}) =>
  entry("import.applied", daysAgo, { source: "mattermost", job_id: JOB, attempt: 1, administrators: 3, guests: 2, moderators: 4, groups: 5, custom_roles: 0, fallbacks: 0, ...over });
const RIGHTS = ["audit.view", "members.manage"];

test("the_banner_shows_the_latest_import_of_the_week", () => {
  // The log lists the newest first; a second import two days earlier is not the one shown.
  const b = importBanner([entry("member.joined", 0), applied(0, { administrators: 3 }), applied(2, { administrators: 9 })], NOW, RIGHTS);
  assert.ok(b);
  assert.equal(b.source, "Mattermost");
  assert.equal(b.jobId, JOB);
  assert.deepEqual(b.when, { kind: "today", days: 0 });
  assert.deepEqual(b.figures.map((f) => [f.kind, f.count]), [["administrators", 3], ["guests", 2], ["moderators", 4], ["groups", 5]]);
  assert.deepEqual(importBanner([applied(1)], NOW, RIGHTS)?.when, { kind: "yesterday", days: 1 });
  assert.deepEqual(importBanner([applied(5)], NOW, RIGHTS)?.when, { kind: "days", days: 5 });
});

test("no_banner_after_seven_days_or_without_audit_view", () => {
  assert.equal(importBanner([applied(8)], NOW, RIGHTS), null);
  assert.equal(importBanner([applied(7.5)], NOW, RIGHTS), null);
  assert.equal(importBanner([applied(0)], NOW, ["members.manage"]), null);
  assert.equal(importBanner([], NOW, RIGHTS), null);
  assert.equal(importBanner([entry("member.joined", 0)], NOW, RIGHTS), null);
});

test("a_guest_made_by_the_import_says_so", () => {
  assert.equal(guestMadeByImport({ importedFrom: `mattermost:${JOB}` }), true);
  assert.equal(guestMadeByImport({}), false);
  assert.equal(guestMadeByImport({ importedFrom: undefined }), false);
});

test("an_imported_group_says_where_it_comes_from_unless_it_has_a_description", () => {
  assert.equal(importedGroupSource({ importedFrom: `mattermost:${JOB}` }), "Mattermost");
  assert.equal(importedGroupSource({ importedFrom: `mattermost:${JOB}`, description: "Les comptes, les devis et les factures." }), null);
  assert.equal(importedGroupSource({ importedFrom: `teams:${JOB}`, description: "" }), "Teams");
  assert.equal(importedGroupSource({}), null);
});

const dict = (locale: string) =>
  JSON.parse(readFileSync(new URL(`../../lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, Record<string, string>>;

test("import_applied_has_a_journal_sentence_in_six_locales", () => {
  const line = auditLine(applied(0));
  assert.equal(line.sentence, "importApplied");
  assert.deepEqual(line.slots.source, { kind: "person", name: "Mattermost" });
  assert.deepEqual(line.slots.actor, { kind: "person", name: "Camille Martin" });
  for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
    const d = dict(locale);
    assert.ok(d.audit.importApplied?.includes("{{actor}}") && d.audit.importApplied.includes("{{source}}"), `${locale} audit.importApplied`);
    assert.ok(d.audit.importReport?.trim(), `${locale} audit.importReport`);
    assert.ok(d.audit.importNote?.trim(), `${locale} audit.importNote`);
  }
});

test("zero_figures_make_no_chip", () => {
  assert.deepEqual(chipsFor({ administrators: 3, guests: 0, moderators: 0, groups: 5, custom_roles: 0 }).map((c) => c.kind), ["administrators", "groups"]);
  assert.deepEqual(chipsFor({ administrators: 0, guests: 0, moderators: 0, groups: 0 }), []);
  assert.deepEqual(chipsFor({}), []);
  assert.deepEqual(auditLine(applied(0, { guests: 0, moderators: 0 })).figures?.map((c) => c.kind), ["administrators", "groups"]);
});

test("the_report_link_opens_the_job", () => {
  assert.equal(reportLink(JOB), JOB);
  assert.equal(reportLink(undefined), null);
  assert.equal(reportLink(""), null);
  assert.equal(auditLine(applied(0)).report, JOB);
  assert.equal(auditLine(entry("import.applied", 0, { source: "slack" })).report, undefined);
});
