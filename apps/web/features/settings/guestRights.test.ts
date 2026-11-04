// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditLine } from "./auditLogic.ts";
import { CEILING_SENTENCES, GUEST_CEILING, rightsEntry } from "./guestCeiling.ts";
import { guestBanner, isGuestsOnly } from "./guestLogic.ts";

test("the_banner_shows_the_end_or_none", () => {
  assert.deepEqual(guestBanner("guest", "2026-12-12T22:59:59Z"), { dated: true, until: "2026-12-12T22:59:59Z" });
  assert.deepEqual(guestBanner("guest", undefined), { dated: false });
});

test("only_a_guest_sees_the_banner", () => {
  for (const role of ["owner", "admin", "member"]) assert.equal(guestBanner(role, "2026-12-12T22:59:59Z"), null);
});

test("the_ceiling_summary_lists_every_never_permission", () => {
  // The list is read from the engine's own source, so a permission added to the ceiling there
  // fails here until a sentence says it.
  const rust = readFileSync(new URL("../../../api/src/permissions/system_roles.rs", import.meta.url), "utf8");
  const block = /pub const GUEST_CEILING: PermissionSet = PermissionSet::of\(&\[([\s\S]*?)\]\);/.exec(rust)?.[1] ?? "";
  const names = [...block.matchAll(/Permission::(\w+)/g)].map((m) => m[1]);
  assert.equal(names.length, GUEST_CEILING.length);
  const covered = CEILING_SENTENCES.flatMap((s) => s.permissions);
  for (const permission of GUEST_CEILING) assert.ok(covered.includes(permission), `${permission} has no sentence`);
  for (const permission of covered) assert.ok(GUEST_CEILING.includes(permission as never), `${permission} is not in the ceiling`);
  // Every Rust permission name is in the web list, by its wire name in the catalogue.
  const catalogue = readFileSync(new URL("../../../api/src/permissions/catalogue.rs", import.meta.url), "utf8");
  for (const name of names) {
    const wire = new RegExp(`\\b${name} = "([a-z_.]+)"`).exec(catalogue)?.[1];
    assert.ok(wire && GUEST_CEILING.includes(wire as never), `${name} (${wire}) missing from the web ceiling`);
  }
});

test("the_rights_entry_opens_the_editor_when_licensed", () => {
  assert.equal(rightsEntry("enterprise"), "editor");
});

test("the_rights_entry_shows_the_summary_when_community", () => {
  assert.equal(rightsEntry("community"), "summary");
  // A frozen licence keeps what it configured but changes nothing paid: read only.
  assert.equal(rightsEntry("frozen"), "summary");
});

test("a_group_of_guests_only_carries_the_tag", () => {
  const people = [
    { userId: "a", role: "guest" },
    { userId: "b", role: "guest" },
    { userId: "c", role: "member" },
  ];
  assert.equal(isGuestsOnly({ memberIds: ["a", "b"] }, people), true);
  assert.equal(isGuestsOnly({ memberIds: ["a", "c"] }, people), false);
  assert.equal(isGuestsOnly({ memberIds: [] }, people), false);
  assert.equal(isGuestsOnly({ memberIds: ["a", "gone"] }, people), false);
});

const entry = (action: string, details: Record<string, unknown> = {}, actor: { id: string; name: string } | null = { id: "k", name: "Karim" }) => ({
  at: "2026-11-03T14:32:00Z", action, actor: actor ?? undefined, target: { kind: "member", id: "h", label: "Hugo" }, details,
});

test("every_expiry_action_has_a_journal_sentence", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["member.expiry_set", { before: null, after: "2026-11-20T22:59:59Z" }, "guestExpiryFixed"],
    ["member.expiry_set", { before: "2026-11-20T22:59:59Z", after: "2026-12-12T22:59:59Z" }, "guestExpiryMoved"],
    ["member.expiry_set", { before: "2026-11-20T22:59:59Z", after: null }, "guestExpiryRemoved"],
    ["member.expired", { role: "guest" }, "guestExpired"],
    ["member.reactivated", { before: null, after: "2026-11-20T22:59:59Z" }, "guestReactivated"],
    ["member.standing_changed", { before: "guest", after: "member" }, "guestToMember"],
    ["member.standing_changed", { before: "member", after: "guest" }, "memberToGuest"],
    ["member.purged", { role: "guest" }, "guestPurged"],
  ];
  for (const [action, details, sentence] of cases) assert.equal(auditLine(entry(action, details)).sentence, sentence, `${action} ${JSON.stringify(details)}`);
  // The before and the after travel with the line, for the two chips.
  const moved = auditLine(entry("member.expiry_set", { before: "2026-11-20T22:59:59Z", after: "2026-12-12T22:59:59Z" }));
  assert.equal(moved.values.before, "2026-11-20T22:59:59Z");
  assert.equal(moved.values.after, "2026-12-12T22:59:59Z");
  // The sweep has no person behind it.
  assert.deepEqual(auditLine(entry("member.expired", { role: "guest" }, null)).slots.actor, { kind: "deleted" });

  // Six locales say all of them.
  const sentences = [...new Set(cases.map((c) => c[2]))];
  for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
    const audit = (JSON.parse(readFileSync(new URL(`../../lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as { audit: Record<string, string> }).audit;
    for (const sentence of sentences) assert.ok(audit[sentence]?.length > 0, `${locale} audit.${sentence}`);
  }
});
