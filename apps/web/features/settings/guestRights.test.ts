// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditLine } from "./auditLogic.ts";
import { CEILING_SENTENCES, GUEST_CEILING, rightsEntry } from "./guestCeiling.ts";
import { displayZone, guestBanner, isGuestsOnly, setProfileZone } from "./guestLogic.ts";

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
    ["member.expiry_set", { before: "2026-11-20T22:59:59Z", after: "2026-12-12T22:59:59Z" }, "guestExpiryExtended"],
    ["member.expiry_set", { before: "2026-12-12T22:59:59Z", after: "2026-11-20T22:59:59Z" }, "guestExpiryAdvanced"],
    ["member.expiry_set", { before: "2026-11-20T22:59:59Z", after: "2026-11-20T22:59:59Z" }, "guestExpiryMoved"],
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

test("guest_lines_sit_under_the_guests_category", async () => {
  const { AUDIT_CATEGORIES, lineCategory } = await import("./auditLogic.ts");
  assert.ok(AUDIT_CATEGORIES.includes("guests"));
  // The filter keeps the earlier families, in order, then the guests, then the access rules.
  assert.deepEqual([...AUDIT_CATEGORIES], ["members", "roles", "groups", "channels", "calendars", "licence", "guests", "access"]);
  for (const action of ["member.expiry_set", "member.expired", "member.reactivated", "member.standing_changed", "member.purged"]) {
    assert.equal(lineCategory({ action, category: "guests" }), "guests", action);
  }
  assert.equal(lineCategory({ action: "member.joined", category: "members" }), "members");
  assert.equal(lineCategory({ action: "rule.created", category: "access" }), "access");
  // A category this app does not know reads as members, never as a missing tag.
  assert.equal(lineCategory({ action: "x", category: "future" }), "members");
});

test("an_all_guest_group_chip_carries_the_tag", async () => {
  const { groupTagFor } = await import("./guestLogic.ts");
  const people = [{ userId: "a", role: "guest" }, { userId: "b", role: "guest" }, { userId: "c", role: "member" }];
  assert.equal(groupTagFor({ memberIds: ["a", "b"] }, people), "guests");
  assert.equal(groupTagFor({ memberIds: ["a", "c"] }, people), null);
  // With no list of people to judge by, no tag is guessed.
  assert.equal(groupTagFor({ memberIds: ["a"] }, undefined), null);
});

test("standing_lines_carry_their_chips", () => {
  const toMember = auditLine(entry("member.standing_changed", { before: "guest", after: "member", expires_at: { before: "2026-12-31T22:59:59Z", after: null } }));
  assert.deepEqual(toMember.chips, [
    { sign: "+", what: "member" },
    { sign: "-", what: "guest" },
    { sign: "-", what: "until", date: "2026-12-31T22:59:59Z" },
  ]);
  // Without the date in the payload, no date chip is invented.
  assert.deepEqual(auditLine(entry("member.standing_changed", { before: "guest", after: "member" })).chips, [{ sign: "+", what: "member" }, { sign: "-", what: "guest" }]);
  const toGuest = auditLine(entry("member.standing_changed", { before: "member", after: "guest", expires_at: { before: null, after: "2026-12-31T22:59:59Z" } }));
  assert.deepEqual(toGuest.chips, [{ sign: "+", what: "guest" }, { sign: "-", what: "member" }, { sign: "+", what: "until", date: "2026-12-31T22:59:59Z" }]);
  assert.deepEqual(auditLine(entry("member.expired", { role: "guest" })).chips, [{ sign: "-", what: "space" }]);
  assert.deepEqual(auditLine(entry("member.purged", { role: "guest" })).chips, [{ sign: "-", what: "space" }]);
});

test("each_refusal_has_its_sentence", async () => {
  const { guestRefusalKey } = await import("./guestLogic.ts");
  const rust = ["permissions/expiry_routes.rs", "messaging/spaces.rs"].map((f) => readFileSync(new URL(`../../../api/src/${f}`, import.meta.url), "utf8")).join("\n");
  const codes = ["bad_expiry", "guest_only", "access_ended", "not_ended", "access_ended_for_good"];
  const keys = new Set<string>();
  for (const code of codes) {
    assert.ok(rust.includes(`"${code}"`), `${code} is a code the API sends`);
    const k = guestRefusalKey(code);
    assert.ok(k, `${code} has a key`);
    keys.add(k!);
  }
  assert.equal(keys.size, codes.length, "one sentence each");
  assert.equal(guestRefusalKey("seats_full"), null);
  for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
    const guests = (JSON.parse(readFileSync(new URL(`../../lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as { guests: Record<string, string> }).guests;
    for (const k of keys) assert.ok(guests[k.replace("guests.", "")]?.length > 0, `${locale} ${k}`);
  }
});

import { GUEST_TUNABLE, guestRightsAfter } from "./guestCeiling.ts";

test("the_tunable_guest_rights_never_overlap_the_ceiling", () => {
  for (const p of GUEST_TUNABLE) assert.equal((GUEST_CEILING as readonly string[]).includes(p), false, p);
});

test("saving_the_guest_dialog_changes_only_the_tunable_rights", () => {
  const current = ["channel.view", "files.view", "message.send", "message.react", "message.pin"];
  const after = guestRightsAfter(current, new Set(["message.send", "dm.start"]));
  assert.deepEqual([...after].sort(), ["channel.view", "dm.start", "files.view", "message.send"].sort());
  // Nothing outside the list can be switched on through it.
  assert.deepEqual(guestRightsAfter(["channel.view"], new Set(["members.manage"])), ["channel.view"]);
});

test("the_expired_line_carries_the_date_that_was_reached", () => {
  const line = auditLine(entry("member.expired", { role: "guest", expires_at: "2026-11-12T22:59:59Z" }));
  assert.equal(line.values.date, "2026-11-12T22:59:59Z");
  // An entry written before the date was kept falls back on the day the sweep wrote it.
  assert.equal(auditLine(entry("member.expired", { role: "guest" })).values.date, "2026-11-03T14:32:00Z");
});

test("no_guest_wording_agrees_with_an_assumed_gender", () => {
  // A guest is "cette personne", "son accès": never "elle", "il", "invitée" in any language.
  const banned: Record<string, RegExp> = {
    fr: /\b(elle|elles|il|invitée|invitées|prévenue)\b/i,
    es: /\b(ella|él|invitada|invitadas)\b/i,
    it: /\b(lei|lui|invitata|invitate)\b/i,
    de: /\b(Gästin|Gästinnen)\b/,
    en: /\b(he|she|his|hers)\b/i,
  };
  for (const [locale, pattern] of Object.entries(banned)) {
    const dictionary = JSON.parse(readFileSync(new URL(`../../lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
    for (const section of ["guests", "audit", "roles", "groups"]) {
      for (const [name, text] of Object.entries(dictionary[section] ?? {})) {
        if (typeof text !== "string") continue;
        if (!/guest|Guest|invit|Gast|gast|ospit|Expiry|expired/i.test(name + text)) continue;
        // `invitées` and `elles` as a plural of "personnes" are fine only where a noun is named.
        assert.equal(pattern.test(text.replace(/ces personnes[^.]*\./gi, "")), false, `${locale} ${section}.${name}: ${text}`);
      }
    }
  }
});

test("guest_dates_use_the_profile_zone_when_one_is_set_else_the_browsers", () => {
  setProfileZone("Asia/Tokyo");
  assert.equal(displayZone(), "Asia/Tokyo");
  setProfileZone(undefined);
  assert.equal(displayZone(), Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
});
