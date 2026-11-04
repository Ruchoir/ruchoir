// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fullPath, authorNote, delegationIntro, isYou, freeManage, askWho } from "../src/permissionsLogic/access.ts";
import { canCustomise } from "../src/permissionsLogic/customise.ts";
import { everyoneLine, addLevelOptions, calendarLevelOf, canEdit, entryEditable, inheritedLink, withOverrides, entryNote, groupEntries, levelLabelKey, levelOptions, privateNote, readOnlyReason, removable, type EntryLike } from "../src/permissionsLogic/access.ts";

const may = (levels: string[], over: Partial<{ edit: boolean; reason: string }> = {}) => ({
  edit: over.edit ?? true,
  fine: false,
  manageTargetLevels: levels as never,
  reason: over.reason,
});

const entry = (over: Partial<EntryLike> & { kind?: EntryLike["target"]["kind"] } = {}): EntryLike => ({
  id: "3633b614-fdd6-5fc5-a819-a8c9d5c56fcd",
  target: { kind: over.kind ?? "group", id: "7532ecb1-2661-5a23-b725-0713adf42f31", name: "Comptabilité", hidden: false },
  level: "contribute",
  allow: [],
  deny: [],
  clamped: false,
  guest: false,
  viaLegacy: false,
  ...over,
});

const ALL = ["none", "read", "contribute", "manage"];

test("none_is_offered_for_everyone_only", () => {
  const everyone = levelOptions(may(ALL), entry({ kind: "everyone" }), "me").map((o) => o.level);
  assert.deepEqual(everyone, ["none", "read", "contribute", "manage"]);
  for (const kind of ["role", "group", "user"] as const) {
    const levels = levelOptions(may(ALL), entry({ kind }), "me").map((o) => o.level);
    assert.deepEqual(levels, ["read", "contribute", "manage"]);
  }
});

test("only_the_levels_the_viewer_holds_are_offered_and_the_current_one_stays_visible", () => {
  const options = levelOptions(may(["read", "contribute"]), entry({ level: "manage" }), "me");
  const manage = options.find((o) => o.level === "manage");
  assert.equal(manage?.disabled, true);
  assert.equal(manage?.reason, "not_held");
  assert.deepEqual(options.map((o) => o.level), ["read", "contribute", "manage"]);
});

test("manage_is_disabled_for_a_guest_with_a_reason", () => {
  const options = levelOptions(may(ALL), entry({ kind: "user", guest: true, level: "read" }), "me");
  const manage = options.find((o) => o.level === "manage");
  assert.equal(manage?.disabled, true);
  assert.equal(manage?.reason, "guest");
  assert.equal(options.find((o) => o.level === "contribute")?.disabled, undefined);
});

test("nobody_edits_a_rule_aimed_at_themselves", () => {
  const mine = entry({ kind: "user" });
  mine.target.id = "me";
  const options = levelOptions(may(ALL), mine, "me");
  assert.ok(options.every((o) => o.disabled && o.reason === "self"));
  assert.equal(removable(mine, "me"), false);
});

test("a_custom_entry_shows_personalised_and_is_not_selectable", () => {
  const options = levelOptions(may(ALL), entry({ level: "custom" }), "me");
  const custom = options.find((o) => o.level === "custom");
  assert.equal(custom?.disabled, true);
  assert.equal(levelLabelKey("channel", "custom"), "access.level.custom");
  assert.equal(levelLabelKey("file", "contribute"), "access.level.file.contribute");
  assert.equal(levelLabelKey("calendar", "contribute"), "access.level.calendar.contribute");
  assert.equal(levelLabelKey("channel", "none"), "access.level.none");
});

test("a_group_line_under_a_higher_everyone_says_au_moins", () => {
  const everyone = entry({ kind: "everyone", level: "contribute" });
  const group = entry({ kind: "group", level: "read" });
  assert.deepEqual(entryNote(group, [everyone, group]), { type: "atLeast", level: "contribute" });
  // Not lower: no note.
  assert.equal(entryNote(entry({ kind: "group", level: "manage" }), [everyone]), undefined);
  // Everyone's own line never says it.
  assert.equal(entryNote(everyone, [everyone]), undefined);
});

test("a_deny_and_a_custom_entry_say_what_they_are", () => {
  assert.deepEqual(entryNote(entry({ kind: "user", level: "none" }), []), { type: "deny" });
  const except = entry({ level: "custom", summary: { nearest: "contribute", changes: [{ permission: "message.pin", state: "deny" }] } });
  assert.deepEqual(entryNote(except, []), { type: "custom", nearest: "contribute", mode: "except", count: 1 });
  const plus = entry({
    level: "custom",
    summary: { nearest: "read", changes: [{ permission: "a", state: "allow" }, { permission: "b", state: "allow" }] },
  });
  assert.deepEqual(entryNote(plus, []), { type: "custom", nearest: "read", mode: "plus", count: 2 });
  const mixed = entry({ level: "custom", summary: { nearest: "read", changes: [{ permission: "a", state: "allow" }, { permission: "b", state: "deny" }] } });
  assert.deepEqual(entryNote(mixed, []), { type: "custom", nearest: "read", mode: "changes", count: 2 });
});

test("a_clamped_group_and_an_inherited_line_are_said", () => {
  assert.deepEqual(entryNote(entry({ clamped: true }), []), { type: "clamped" });
  const inherited = entry({ inheritedFrom: { kind: "folder", id: "9a49e33a-5efb-506c-97f9-a07f0242714f", name: "Compta", hidden: false }, id: undefined });
  assert.deepEqual(entryNote(inherited, []), { type: "inherited", folder: "Compta" });
});

test("canEdit_follows_the_server_and_the_archive", () => {
  assert.equal(canEdit({ archived: false, may: may(ALL) }), true);
  assert.equal(canEdit({ archived: true, may: may(ALL) }), false);
  assert.equal(canEdit({ archived: false, may: may([], { edit: false, reason: "not_allowed" }) }), false);
});

test("a_read_only_dialog_says_why", () => {
  assert.equal(readOnlyReason({ archived: false, may: may([], { edit: false, reason: "licence_required" }) }), "access.readOnly.licenceRequired");
  assert.equal(readOnlyReason({ archived: false, may: may([], { edit: false, reason: "licence_frozen" }) }), "access.readOnly.licenceFrozen");
  assert.equal(readOnlyReason({ archived: false, may: may([], { edit: false, reason: "not_allowed" }) }), "access.readOnly.notAllowed");
  assert.equal(readOnlyReason({ archived: true, may: may(ALL) }), "access.readOnly.archived");
  assert.equal(readOnlyReason({ archived: false, may: may(ALL) }), undefined);
});

test("a_private_channel_note_names_the_lift", () => {
  assert.deepEqual(privateNote(true, ["Karim Benali"]), { names: ["Karim Benali"] });
  assert.equal(privateNote(true, []), undefined);
  assert.equal(privateNote(false, ["Karim Benali"]), undefined);
});

test("the_add_dialog_greys_manage_when_a_guest_is_picked", () => {
  const withGuest = addLevelOptions(may(ALL), [{ kind: "user", guest: true }, { kind: "group", guest: false }]);
  assert.equal(withGuest.find((o) => o.level === "manage")?.reason, "guest");
  assert.deepEqual(withGuest.map((o) => o.level), ["read", "contribute", "manage"]);
  const none = addLevelOptions(may(ALL), [{ kind: "group", guest: false }]);
  assert.ok(none.every((o) => !o.disabled));
});

test("entries_are_grouped_everyone_roles_groups_people_with_inherited_last", () => {
  const e = (kind: EntryLike["target"]["kind"], name: string, extra: Partial<EntryLike> = {}) => {
    const x = entry({ kind, ...extra });
    x.target.name = name;
    return x;
  };
  const rows = groupEntries([e("user", "Marc"), e("group", "Compta"), e("role", "RH"), e("everyone", "Tout"), e("group", "Archive", { inheritedFrom: { kind: "folder", name: "F", hidden: false } })]);
  assert.deepEqual(rows.map((r) => r.target.name), ["Tout", "RH", "Compta", "Archive", "Marc"]);
});

const folderRef = (id: string | undefined, name?: string) => ({ kind: "folder", id, name, hidden: id === undefined });

test("an_inherited_line_links_to_its_folder", () => {
  const line = entry({ id: undefined, inheritedFrom: folderRef("e106010e-830a-53f1-854e-0d5b1635b305", "Compta") });
  assert.deepEqual(inheritedLink(line), { id: "e106010e-830a-53f1-854e-0d5b1635b305", name: "Compta" });
  // A folder the viewer may not see is named "un dossier parent" and has no link.
  assert.equal(inheritedLink(entry({ id: undefined, inheritedFrom: folderRef(undefined) })), undefined);
  // A line of the item itself links nowhere.
  assert.equal(inheritedLink(entry()), undefined);
});

test("an_override_replaces_the_inherited_line", () => {
  const up = (name: string, level: EntryLike["level"], from?: string): EntryLike => {
    const e = entry({ id: from ? undefined : "p1", level, inheritedFrom: from ? folderRef("9a49e33a-5efb-506c-97f9-a07f0242714f", from) : undefined });
    e.target = { kind: "group", id: "7532ecb1-2661-5a23-b725-0713adf42f31", name, hidden: false };
    return e;
  };
  const own = entry({ id: "3633b614-fdd6-5fc5-a819-a8c9d5c56fcd", level: "read" });
  // The parent's view says the group may contribute, from the folder Compta.
  const merged = withOverrides([own, up("Comptabilité", "contribute", "Compta")], [up("Comptabilité", "contribute", "Compta")], "2026");
  assert.equal(merged.entries.length, 1);
  assert.deepEqual(merged.overrides.get("group:7532ecb1-2661-5a23-b725-0713adf42f31"), { level: "contribute", folder: "Compta" });
  // Another target stays inherited and nothing is overridden for it.
  const other = entry({ id: undefined, inheritedFrom: folderRef("9a49e33a-5efb-506c-97f9-a07f0242714f", "Compta") });
  other.target = { kind: "role", id: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", name: "Admin", hidden: false };
  const kept = withOverrides([own, other], [other], "2026");
  assert.equal(kept.entries.length, 2);
  assert.equal(kept.overrides.has("role:c6f204bc-8cc0-55a4-b2e2-799dcda9120e"), false);
  // The parent's own line (not inherited by it) is named after the parent.
  const direct = withOverrides([own], [up("Comptabilité", "contribute")], "2026");
  assert.equal(direct.overrides.get("group:7532ecb1-2661-5a23-b725-0713adf42f31")?.folder, "2026");
  // Without the parent's view nothing is claimed.
  assert.equal(withOverrides([own], undefined, undefined).overrides.size, 0);
});

test("the_calendar_write_toggle_maps_to_levels", () => {
  assert.equal(calendarLevelOf("members"), "contribute");
  assert.equal(calendarLevelOf("admins"), "read");
});

test("a_member_without_edit_sees_the_list_read_only", () => {
  const view = { archived: false, may: may([], { edit: false, reason: "not_allowed" }) };
  assert.equal(entryEditable(view, entry()), false);
  assert.equal(entryEditable({ archived: false, may: may(ALL) }, entry()), true);
  // An inherited line is never edited here, whoever looks.
  assert.equal(entryEditable({ archived: false, may: may(ALL) }, entry({ id: undefined, inheritedFrom: folderRef("9a49e33a-5efb-506c-97f9-a07f0242714f", "F") })), false);
  assert.equal(entryEditable({ archived: true, may: may(ALL) }, entry()), false);
});

test("the_guests_line_is_told_apart_from_everyone", () => {
  // On the wire both lines are `everyone` and name their base role by UUID: only `guest` tells them apart.
  const members = entry({ kind: "everyone", level: "contribute", guest: false });
  members.target.id = "0a1c6d2e-3b4f-4a5b-8c6d-7e8f9a0b1c2d";
  const guests = entry({ kind: "everyone", level: "read", guest: true });
  guests.target.id = "1b2d7e3f-4c50-4b6c-9d7e-8f9a0b1c2d3e";
  assert.equal(everyoneLine(members), "members");
  assert.equal(everyoneLine(guests), "guests");
  assert.equal(everyoneLine(entry({ kind: "group", guest: true })), undefined);
  // The "au moins" note compares with the members line, even when the guests line comes first.
  const group = entry({ kind: "group", level: "read" });
  assert.deepEqual(entryNote(group, [guests, members, group]), { type: "atLeast", level: "contribute" });
  assert.equal(entryNote(group, [guests, group]), undefined);
  // The Personnaliser rule on a calendar: the guests line has it, the members line does not.
  assert.equal(canCustomise("calendar", guests, false), true);
  assert.equal(canCustomise("calendar", members, false), false);
  assert.equal(canCustomise("channel", guests, false), false);
  assert.equal(canCustomise("file", guests, false), true);
});

test("a_free_space_manager_is_told_who_to_ask", () => {
  // The case is a read-only dialog because of the licence; not an archived or frozen one.
  const view = (reason: string | undefined, archived = false) => ({ archived, may: { edit: false, fine: false, manageTargetLevels: [], reason } });
  assert.equal(freeManage(view("licence_required"), "file", true)?.lead, "access.freeManage.title.folder");
  assert.equal(freeManage(view("licence_required"), "file", false)?.detail, "access.freeManage.body.file");
  assert.equal(freeManage(view("licence_required"), "calendar", false)?.cta, "access.freeManage.upsell.calendar");
  assert.equal(freeManage(view("licence_required"), "channel", false)?.lead, "access.freeManage.title.channel");
  assert.equal(freeManage(view("licence_frozen"), "file", false), undefined);
  assert.equal(freeManage(view("not_allowed"), "file", false), undefined);
  assert.equal(freeManage(view("licence_required", true), "file", false), undefined);
  // Who to ask: the owner first, then the administrators, three at most; bots and others never.
  const m = (name: string, role: string, bot = false) => ({ name, role, bot });
  assert.deepEqual(askWho([m("Camille", "admin"), m("Julie", "member"), m("Sophie", "owner"), m("Bot", "admin", true), m("Léo", "admin"), m("Zoé", "admin"), m("Max", "admin")]), ["Sophie", "Camille", "Léo"]);
  assert.deepEqual(askWho([m("Julie", "member")]), []);
  for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
    const dict = JSON.parse(readFileSync(new URL(`../../../apps/web/lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    const has = (key: string) => key.split(".").reduce<unknown>((at, p) => (at as Record<string, unknown> | undefined)?.[p], dict) !== undefined;
    for (const kind of ["channel", "file", "calendar"] as const) for (const folder of [true, false]) {
      const keys = freeManage(view("licence_required"), kind, folder)!;
      for (const key of [keys.lead, keys.detail, keys.cta]) assert.ok(has(key), `${locale}: ${key}`);
    }
    for (const key of ["access.freeManage.subtitle", "access.freeManage.noNames", "common.or", "access.learnMore", "access.verify"]) assert.ok(has(key), `${locale}: ${key}`);
  }
});

test("a_guest_is_compared_with_the_guests_line_only", () => {
  const members = entry({ kind: "everyone", level: "contribute", guest: false });
  const guests = entry({ kind: "everyone", level: "contribute", guest: true });
  // A guest at Lire under a guests line at Participer is "au moins Participer"; under only the
  // members line it says nothing (the members' level is not the guests' floor).
  const marc = entry({ kind: "user", level: "read", guest: true });
  assert.deepEqual(entryNote(marc, [members, marc]), undefined);
  assert.deepEqual(entryNote(marc, [members, guests, marc]), { type: "atLeast", level: "contribute" });
  // A member keeps comparing with the members line, whatever the guests line says.
  const hugo = entry({ kind: "user", level: "read", guest: false });
  assert.deepEqual(entryNote(hugo, [guests, hugo]), undefined);
  assert.deepEqual(entryNote(hugo, [guests, members, hugo]), { type: "atLeast", level: "contribute" });
});

test("the_viewers_own_line_is_the_one_tagged_vous", () => {
  const me = "9f1c6d2e-3b4f-4a5b-8c6d-7e8f9a0b1c2d";
  const mine = entry({ kind: "user" });
  mine.target.id = me;
  assert.equal(isYou(mine, me), true);
  assert.equal(isYou(mine, "someone-else"), false);
  assert.equal(isYou(entry({ kind: "group" }), me), false);
  assert.equal(isYou(mine, undefined), false);
});

test("a_local_manager_is_told_what_they_may_do", () => {
  const me = "9f1c6d2e-3b4f-4a5b-8c6d-7e8f9a0b1c2d";
  const mine = entry({ kind: "user", level: "manage" });
  mine.target.id = me;
  const view = (fine: boolean, edit = true, archived = false) => ({ archived, may: { edit, fine, manageTargetLevels: [], reason: undefined }, entries: [mine] });
  // An editor who holds Gérer here by their own line, with the paid edition: frame 10.
  assert.equal(delegationIntro(view(true), me, "file", true), "access.delegation.folder");
  assert.equal(delegationIntro(view(true), me, "file", false), "access.delegation.file");
  assert.equal(delegationIntro(view(true), me, "calendar", false), "access.delegation.calendar");
  assert.equal(delegationIntro(view(true), me, "channel", false), "access.delegation.channel");
  // Not without the paid edition (frame 11 says it differently), not read only, not for someone else.
  assert.equal(delegationIntro(view(false), me, "file", true), undefined);
  assert.equal(delegationIntro(view(true, false), me, "file", true), undefined);
  assert.equal(delegationIntro(view(true), "other", "file", true), undefined);
  mine.level = "contribute";
  assert.equal(delegationIntro(view(true), me, "file", true), undefined);
  for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
    const dict = JSON.parse(readFileSync(new URL(`../../../apps/web/lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    for (const key of ["access.delegation.folder", "access.delegation.file", "access.delegation.calendar", "access.delegation.channel", "access.delegationHead", "access.delegationBody", "access.delegationFoot", "access.you"]) {
      assert.ok(key.split(".").reduce<unknown>((at, p) => (at as Record<string, unknown> | undefined)?.[p], dict) !== undefined, `${locale}: ${key}`);
    }
  }
});

const VIEWER = "9f1c6d2e-3b4f-4a5b-8c6d-7e8f9a0b1c2d";
const KARIM = "4f506172-8394-4ea5-9fb6-d7e8f9a0b1c2";

test("an_entry_names_who_gave_it", () => {
  const given = entry({ kind: "user", setBy: { id: KARIM, name: "Karim Benali" } });
  assert.deepEqual(authorNote(given, VIEWER), { type: "other", name: "Karim Benali" });
});

test("an_entry_the_viewer_added_says_so", () => {
  const mine = entry({ kind: "user", setBy: { id: VIEWER, name: "Julie Moreau" } });
  assert.deepEqual(authorNote(mine, VIEWER), { type: "you" });
  // Without knowing who is looking, nobody is "you".
  assert.deepEqual(authorNote(mine, undefined), { type: "other", name: "Julie Moreau" });
});

test("no_author_no_line", () => {
  assert.equal(authorNote(entry({ kind: "user" }), VIEWER), undefined);
  assert.equal(authorNote(entry({ kind: "user", setBy: undefined }), undefined), undefined);
  for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
    const dict = JSON.parse(readFileSync(new URL(`../../../apps/web/lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    for (const key of ["access.givenBy", "access.addedByYou"]) assert.ok(key.split(".").reduce<unknown>((at, p) => (at as Record<string, unknown> | undefined)?.[p], dict) !== undefined, `${locale}: ${key}`);
  }
});

test("an_override_takes_the_place_of_what_it_replaces", () => {
  const line = (kind: EntryLike["target"]["kind"], name: string, over: Partial<EntryLike> = {}) => {
    const e = entry({ kind, ...over });
    e.target = { kind, id: `${kind}-${name}`, name, hidden: false };
    return e;
  };
  const from = { kind: "file", name: "Compta", hidden: false };
  // Frame 7: Administrateur, the readers of a channel, the group (its own line, overriding the
  // inherited one), then people. The override sits where the inherited group line sat, not last.
  const rows = groupEntries([
    line("user", "Nadia", { inheritedFrom: from, id: undefined }),
    line("group", "Comptabilité", { level: "read" }),
    line("audience", "Lecteurs", { inheritedFrom: from, id: undefined }),
    line("role", "Administrateur", { inheritedFrom: from, id: undefined }),
  ]);
  assert.deepEqual(rows.map((r) => r.target.name), ["Administrateur", "Lecteurs", "Comptabilité", "Nadia"]);
});

test("inherited_rows_name_no_giver", () => {
  const inherited = entry({ kind: "user", id: undefined, inheritedFrom: { kind: "file", name: "Compta", hidden: false }, setBy: { id: KARIM, name: "Karim Benali" } });
  assert.equal(authorNote(inherited, VIEWER), undefined);
  assert.deepEqual(authorNote(entry({ kind: "user", setBy: { id: KARIM, name: "Karim Benali" } }), VIEWER), { type: "other", name: "Karim Benali" });
});

test("the_subtitle_gives_the_full_path", () => {
  assert.equal(fullPath(["Compta", "2026"]), "Compta / 2026");
  assert.equal(fullPath(["2026"]), "2026");
  assert.equal(fullPath([]), undefined);
});
