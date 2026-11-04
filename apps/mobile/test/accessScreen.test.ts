import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { addRows, communityLock, levelGlossary, privateNoteFor, verifyPeople, viaAsks, viaNote, customiseDecision, customiseView, entryLine, entryRows, findEntry, levelRows, resultRows, subtitleOf, titleOf, whyCards } from "../src/logic/accessScreen.ts";

type Target = { kind: "everyone" | "role" | "group" | "user" | "audience"; id?: string; name?: string; hidden: boolean };
const entry = (target: Omit<Target, "hidden">, over: Record<string, unknown> = {}) => ({
  id: `rule-${target.kind}-${target.id ?? "x"}`,
  target: { ...target, hidden: false },
  level: "contribute" as "none" | "read" | "contribute" | "manage" | "custom",
  allow: [] as string[],
  deny: [] as string[],
  clamped: false,
  guest: false,
  viaLegacy: false,
  ...over,
});
const may = (over: Record<string, unknown> = {}) => ({
  edit: true,
  fine: true,
  manageTargetLevels: ["read", "contribute", "manage"] as ("none" | "read" | "contribute" | "manage" | "custom")[],
  held: ["channel.view", "message.send"],
  ...over,
});
// A fake translator: the key and its variables, so the tests read which sentence was chosen.
const say = (key: string, vars?: Record<string, string | number>) =>
  vars && Object.keys(vars).length > 0 ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

test("an_override_takes_the_place_of_the_inherited_line_and_the_rest_keeps_its_order", () => {
  const julieOwn = entry({ kind: "user", id: "julie", name: "Julie" }, { level: "manage" });
  const julieAbove = entry({ kind: "user", id: "julie", name: "Julie" }, { id: undefined, level: "read", inheritedFrom: { kind: "file", id: "f1", name: "Compta", hidden: false } });
  const hugoAbove = entry({ kind: "user", id: "hugo", name: "Hugo" }, { id: undefined, level: "read", inheritedFrom: { kind: "file", id: "f1", name: "Compta", hidden: false } });
  const group = entry({ kind: "group", id: "g1", name: "Comptabilité" });
  const role = entry({ kind: "role", id: "r1", name: "Comptable" });
  const everyone = entry({ kind: "everyone", name: "@members" }, { id: undefined, level: "read" });
  const parent = { name: "Compta", entries: [julieAbove, hugoAbove] };
  const rows = entryRows([julieOwn, group, hugoAbove, julieAbove, role, everyone], parent);
  assert.deepEqual(rows.map((r) => `${r.entry.target.kind}:${r.entry.target.id ?? ""}`), ["everyone:", "role:r1", "group:g1", "user:julie", "user:hugo"]);
  assert.equal(rows[3]?.override?.level, "read");
  assert.equal(rows[3]?.override?.folder, "Compta");
  assert.equal(rows[4]?.override, undefined);
  assert.equal(entryRows([julieOwn], undefined)[0]?.override, undefined);
});

test("each_kind_words_its_levels_and_their_descriptions", () => {
  const person = entry({ kind: "user", id: "julie" });
  const ids = (kind: "channel" | "calendar" | "file") => levelRows(kind, may(), person, "me", { editable: true, customise: "hidden" });
  assert.deepEqual(ids("channel").map((r) => r.id), ["remove", "read", "contribute", "manage"]);
  const mid = (kind: "channel" | "calendar" | "file") => ids(kind).find((r) => r.id === "contribute")!;
  assert.deepEqual([mid("channel").titleKey, mid("channel").descKey], ["access.level.channel.contribute", "access.levelDesc.channel.contribute"]);
  assert.deepEqual([mid("calendar").titleKey, mid("calendar").descKey], ["access.level.calendar.contribute", "access.levelDesc.calendar.contribute"]);
  assert.deepEqual([mid("file").titleKey, mid("file").descKey], ["access.level.file.contribute", "access.levelDesc.file.contribute"]);
  assert.equal(ids("channel").find((r) => r.selected)?.id, "contribute");
  // Aucun acces on a person removes the line; on the base line it reserves, and nothing is removed.
  assert.equal(ids("channel")[0]?.effect, "remove");
  const base = levelRows("channel", may({ manageTargetLevels: ["none", "read", "contribute", "manage"] }), entry({ kind: "everyone" }, { id: undefined, level: "read" }), "me", { editable: true, customise: "hidden" });
  assert.deepEqual(base.map((r) => r.id), ["none", "read", "contribute", "manage"]);
  assert.equal(base[0]?.effect, "set");
});

test("a_guest_cannot_be_given_manage_and_one_does_not_edit_ones_own_line", () => {
  const guest = entry({ kind: "user", id: "thomas" }, { guest: true, level: "read" });
  const rows = levelRows("channel", may(), guest, "me", { editable: true, customise: "hidden" });
  assert.deepEqual(rows.find((r) => r.id === "manage")?.reasonKey, "access.guestCap");
  assert.equal(rows.find((r) => r.id === "manage")?.disabled, true);
  const mine = levelRows("channel", may(), entry({ kind: "user", id: "me" }), "me", { editable: true, customise: "hidden" });
  assert.ok(mine.filter((r) => r.effect === "set").every((r) => r.disabled && r.reasonKey === "access.selfLocked"));
  assert.ok(!mine.some((r) => r.id === "remove"));
  const readOnly = levelRows("channel", may({ edit: false }), person(), "me", { editable: false, customise: "hidden" });
  assert.ok(!readOnly.some((r) => r.id === "remove"));
});
const person = () => entry({ kind: "user", id: "julie" });

test("personalise_is_offered_when_the_edition_allows_it_and_reads_as_the_current_level_once_set", () => {
  const open = levelRows("channel", may(), person(), "me", { editable: true, customise: "open" });
  assert.equal(open.at(-1)?.id, "custom");
  assert.equal(open.at(-1)?.effect, "customise");
  const set = levelRows("channel", may(), entry({ kind: "user", id: "julie" }, { level: "custom" }), "me", { editable: true, customise: "open" });
  assert.equal(set.filter((r) => r.id === "custom").length, 1);
  assert.equal(set.find((r) => r.id === "custom")?.selected, true);
  assert.ok(!levelRows("channel", may({ fine: false }), person(), "me", { editable: true, customise: "locked" }).some((r) => r.id === "custom"));
});

test("the_adding_sheet_offers_the_levels_held_and_greys_manage_for_a_guest", () => {
  assert.deepEqual(addRows("calendar", may(), [{ kind: "user", guest: false }]).map((r) => [r.id, r.disabled ?? false]), [["read", false], ["contribute", false], ["manage", false]]);
  const withGuest = addRows("calendar", may(), [{ kind: "user", guest: true }]);
  assert.equal(withGuest.find((r) => r.id === "manage")?.reasonKey, "access.guestCap");
  assert.deepEqual(addRows("file", may({ manageTargetLevels: ["read"] }), []).map((r) => r.id), ["read"]);
});

test("the_customise_draft_counts_what_changed_and_sends_each_permission_once", () => {
  const julie = entry({ kind: "user", id: "julie" }, { level: "custom", allow: ["message.attach"], deny: [], summary: { nearest: "contribute", changes: [{ permission: "message.attach", state: "allow" }] } });
  const held = ["channel.view", "message.react", "message.send", "message.attach", "message.pin", "message.mention_all"];
  const start = customiseView("channel", julie, held, { "message.attach": "allow" });
  assert.equal(start.changed, 0);
  const next = customiseView("channel", julie, held, { "message.attach": "allow", "message.pin": "deny", "channel.view": "allow" });
  assert.equal(next.changed, 2);
  assert.deepEqual(next.payload, { allow: ["channel.view", "message.attach"], deny: ["message.pin"] });
  assert.deepEqual(next.families.map((f) => f.group), ["read", "participate", "manage"]);
  assert.equal(next.families[1]?.rows.find((r) => r.permission === "message.pin")?.state, "deny");
  assert.equal(next.families[1]?.rows.find((r) => r.permission === "message.pin")?.edited, true);
  assert.deepEqual(next.result.except, ["message.pin"]);
  // What the editor does not hold is locked with its reason, and a guest never takes the manage rights.
  const manage = next.families[2]!.rows;
  assert.ok(manage.every((r) => r.lock === "not_held"));
  const guest = customiseView("channel", { ...julie, guest: true }, [...held, "message.manage"], {});
  assert.equal(guest.families[2]?.rows.find((r) => r.permission === "message.manage")?.lock, "guest");
});

test("the_locked_customise_row_shows_only_in_a_community_space_and_on_a_line_that_could_have_it", () => {
  const julie = entry({ kind: "user", id: "julie" });
  const base = entry({ kind: "everyone" }, { id: undefined, level: "read" });
  const admin = entry({ kind: "role", id: "admin-role" });
  const community = { archived: false, may: may({ fine: false }) };
  const licensed = { archived: false, may: may({ fine: true }) };
  assert.equal(customiseDecision("channel", community, julie, false), "locked");
  assert.equal(customiseDecision("channel", licensed, julie, false), "open");
  assert.equal(customiseDecision("channel", community, base, false), "hidden");
  assert.equal(customiseDecision("channel", community, admin, true), "hidden");
  assert.equal(customiseDecision("channel", { archived: false, may: may({ edit: false }) }, julie, false), "hidden");
  assert.equal(customiseDecision("channel", { archived: true, may: may() }, julie, false), "hidden");
  assert.equal(customiseDecision("channel", licensed, { ...julie, inheritedFrom: { kind: "file", hidden: false } }, false), "hidden");
  assert.equal(communityLock("channel", community, [base, admin, julie], new Set(["admin-role"]))?.target.id, "julie");
  assert.equal(communityLock("channel", licensed, [base, julie], new Set()), undefined);
  assert.equal(communityLock("channel", community, [base], new Set()), undefined);
});

const step = (n: number, kind: string, permission: string, over: Record<string, unknown> = {}) => ({ n, kind, permission, effect: "granted" as "granted" | "removed", ...over });
const deps = {
  say,
  kind: "channel" as const,
  isFolder: false,
  person: "Thomas Girard",
  locale: "fr",
  permissionName: (p: string) => p,
  list: (names: string[]) => names.join("+"),
  roleName: (ref: { kind: string; id?: string; name?: string; hidden: boolean } | undefined, hidden: string) => (!ref || ref.hidden ? hidden : (ref.name ?? hidden)),
};

test("a_guest_held_back_by_the_ceiling_reads_base_rule_then_the_ceiling_and_a_result", () => {
  const why = {
    person: { id: "thomas", name: "Thomas Girard", roles: [] },
    steps: [
      step(1, "base", "channel.view"),
      step(2, "rule", "message.manage", { target: { kind: "user", id: "thomas", name: "Thomas Girard", hidden: false }, level: { kind: "channel", id: "c1", name: "compta", hidden: false }, ruleLevel: "manage" }),
      step(3, "guest_ceiling", "message.manage", { effect: "removed" }),
      step(4, "guest_ceiling", "channel.members.manage", { effect: "removed" }),
    ],
    result: [
      { permission: "channel.view", granted: true, reasonStep: 1 },
      { permission: "message.send", granted: false },
      { permission: "message.manage", granted: false, reasonStep: 3 },
    ],
  };
  const cards = whyCards(deps, why, [{ id: "c1", name: "compta", item: true }]);
  assert.deepEqual(cards.map((c) => c.type), ["base", "level", "locks"]);
  assert.match(cards[0]!.body, /why\.para\.base\.granted/i);
  assert.equal(cards[0]!.label, "why.label.base");
  assert.match(cards[1]!.label, /compta/);
  assert.match(cards[1]!.body, /why\.para\.rule\.granted/i);
  // Both removed permissions of the ceiling are one sentence, said once.
  assert.equal(cards[2]!.body.match(/why\.step\.guest_ceiling\.removed/g)?.length, 1);
  assert.match(cards[2]!.body, /message\.manage\+channel\.members\.manage/);
  const result = resultRows(say, "channel", why);
  assert.deepEqual(result.map((r) => [r.id, r.granted]), [["view", true], ["participate", false], ["manage", false]]);
  assert.equal(result[0]?.reason, "why.reason.base");
  // The right a rule gave and the ceiling took names the ceiling, not "no rule grants it".
  assert.equal(result[2]?.reason, "why.reason.guest_ceiling");
});

test("the_words_after_a_lead_start_with_a_capital", () => {
  const why = { person: { id: "u", name: "Julie", roles: [] }, steps: [step(1, "base", "channel.view")], result: [{ permission: "channel.view", granted: true, reasonStep: 1 }] };
  const lower = (key: string, vars?: Record<string, string | number>) => (key === "why.locksNone" ? "Verrous : le verrou privé ne change rien ici." : say(key, vars));
  const quiet = whyCards({ ...deps, say: lower }, why, [{ id: "c1", name: "compta", item: true }]).find((c) => c.type === "quiet");
  assert.equal(quiet?.label, "Verrous");
  assert.equal(quiet?.body, "Le verrou privé ne change rien ici.");
});

test("a_quiet_explanation_says_the_locks_changed_nothing_and_an_empty_one_says_so", () => {
  const why = { person: { id: "u", name: "Julie", roles: [] }, steps: [step(1, "base", "channel.view")], result: [{ permission: "channel.view", granted: true, reasonStep: 1 }] };
  assert.deepEqual(whyCards(deps, why, [{ id: "c1", name: "compta", item: true }]).map((c) => c.type), ["base", "level", "quiet"]);
  assert.deepEqual(whyCards(deps, { ...why, steps: [] }, []), []);
});

test("titles_and_subtitles_follow_the_kind_and_what_the_viewer_may_do", () => {
  assert.deepEqual(titleOf("channel", false, "compta"), { key: "access.title", vars: { name: "#compta" } });
  assert.deepEqual(titleOf("calendar", false, "Équipe"), { key: "access.shareCalendarTitle", vars: { name: "Équipe" } });
  assert.deepEqual(titleOf("file", true, "2026"), { key: "access.shareFolderTitle", vars: { name: "2026" } });
  assert.deepEqual(titleOf("file", false, "bilan.xlsx"), { key: "files.shareTitle", vars: { name: "bilan.xlsx" } });
  const view = { private: false, archived: false, entries: [], may: may(), resource: { parent: { id: "f", name: "Clients", hidden: false } } };
  assert.deepEqual(subtitleOf("file", true, view, "me"), { key: "access.subtitleFolderIn", vars: { parent: "Clients" } });
  assert.deepEqual(subtitleOf("channel", false, { ...view, private: true, may: may({ fine: false }) }, "me"), { key: "access.subtitlePrivate", vars: {} });
  assert.equal(subtitleOf("channel", false, { ...view, may: may({ edit: false, fine: false, reason: "licence_required" }) }, "me").key, "access.freeManage.subtitle");
  assert.equal(subtitleOf("calendar", false, view, "me").key, "access.subtitleCalendar");
});

test("a_row_says_who_it_is_and_what_limits_it", () => {
  const thomas = entry({ kind: "user", id: "thomas", name: "Thomas" }, { guest: true, clamped: true, level: "manage" });
  const parts = entryLine(say, thomas, [thomas], { viewerId: "me", kind: "channel", title: "Chef comptable" });
  assert.deepEqual(parts, ["Chef comptable", "invite.guest", "access.guestLimited"]);
  const group = entry({ kind: "group", id: "g1", name: "Comptabilité" });
  assert.deepEqual(entryLine(say, group, [group], { viewerId: "me", kind: "channel", people: 3 }), ["compose.groupLine(count=3)"]);
  const me = entry({ kind: "user", id: "me", name: "Moi" });
  assert.deepEqual(entryLine(say, me, [me], { viewerId: "me", kind: "channel" }), ["spaceAdmin.you"]);
  const base = entry({ kind: "everyone" }, { id: undefined, level: "read" });
  assert.deepEqual(entryLine(say, base, [base], { viewerId: "me", kind: "channel" }), ["access.everyoneSub"]);
  const denied = entry({ kind: "user", id: "paul" }, { level: "none" });
  assert.ok(entryLine(say, denied, [denied], { viewerId: "me", kind: "channel" }).includes("access.denyNote"));
});

test("a_line_is_found_again_after_a_read_the_items_own_before_the_inherited_one", () => {
  const above = entry({ kind: "user", id: "julie" }, { id: undefined, inheritedFrom: { kind: "file", id: "f", name: "Compta", hidden: false } });
  const own = entry({ kind: "user", id: "julie" }, { level: "manage" });
  assert.equal(findEntry([above, own], { kind: "user", id: "julie" }), own);
  assert.equal(findEntry([above], { kind: "user", id: "julie" }), above);
  assert.equal(findEntry([own], { kind: "user", id: "hugo" }), undefined);
});

test("every_key_the_glue_names_is_in_the_six_dictionaries", () => {
  const source = readFileSync(new URL("../src/logic/accessScreen.ts", import.meta.url), "utf8");
  const keys = [...source.matchAll(/["'`]((?:access|why|customise|invite|roles)\.[A-Za-z][\w.]*)["'`]/g)].map((m) => m[1]!);
  assert.ok(keys.length > 20);
  for (const lang of ["fr", "en", "es", "de", "it", "pl"]) {
    const dictionary = JSON.parse(readFileSync(new URL(`../src/i18n/dictionaries/${lang}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    // A plural key lives under its categories (`access.groupSub_one`, `_few` in Polish...).
    const has = (key: string) => flatHas(dictionary, key) || ["one", "other", "few", "many", "zero", "two"].some((c) => flatHas(dictionary, `${key}_${c}`));
    assert.deepEqual(keys.filter((key) => !has(key)), [], lang);
  }
});

test("a_short_list_of_people_is_asked_how_they_already_have_access", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `u${i}` }));
  assert.deepEqual(viaAsks(ids(2)), ["u0", "u1"]);
  assert.equal(viaAsks(ids(6)).length, 6);
  // Each person is one explanation: a long list is not asked.
  assert.deepEqual(viaAsks(ids(7)), []);
});

test("the_note_under_a_person_names_what_gives_them_sight_of_the_item", () => {
  const why = {
    steps: [{ n: 1, kind: "rule", target: { kind: "group", id: "g", name: "Compta", hidden: false } }],
    result: [{ permission: "files.view", granted: true, reasonStep: 1 }],
  } as never;
  assert.equal(viaNote(why, "file"), "Compta");
  // The permission read depends on the kind: this answer says nothing about a channel.
  assert.equal(viaNote(why, "channel"), undefined);
});

test("the_levels_glossary_names_the_three_levels_of_the_kind", () => {
  assert.deepEqual(levelGlossary("calendar"), [
    { label: "access.level.read", desc: "access.levelDesc.calendar.read" },
    { label: "access.level.calendar.contribute", desc: "access.levelDesc.calendar.contribute" },
    { label: "access.level.manage", desc: "access.levelDesc.calendar.manage" },
  ]);
});

test("the_private_note_names_only_those_added_who_are_still_on_the_list", () => {
  const view = { private: true, entries: [{ target: { kind: "user", id: "a" } }, { target: { kind: "group", id: "g" } }] };
  const added = [{ key: "user:a", name: "Léa" }, { key: "user:gone", name: "Paul" }, { key: "group:g", name: "Compta" }];
  assert.deepEqual(privateNoteFor(view, added), { names: ["Léa", "Compta"] });
  assert.equal(privateNoteFor({ ...view, private: false }, added), undefined);
  assert.equal(privateNoteFor(view, []), undefined);
});

test("anyone_but_a_bot_can_be_checked", () => {
  const people = [{ userId: "a", bot: false }, { userId: "b", bot: true }, { userId: "c" }];
  assert.deepEqual(verifyPeople(people).map((m) => m.userId), ["a", "c"]);
});

function flatHas(dictionary: Record<string, unknown>, key: string): boolean {
  const found = key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), dictionary);
  return found !== undefined;
}
