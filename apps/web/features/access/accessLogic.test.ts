import { test } from "node:test";
import assert from "node:assert/strict";

import { addLevelOptions, canEdit, entryNote, groupEntries, levelLabelKey, levelOptions, privateNote, readOnlyReason, removable, type EntryLike } from "./accessLogic.ts";

const may = (levels: string[], over: Partial<{ edit: boolean; reason: string }> = {}) => ({
  edit: over.edit ?? true,
  fine: false,
  manageTargetLevels: levels as never,
  reason: over.reason,
});

const entry = (over: Partial<EntryLike> & { kind?: EntryLike["target"]["kind"] } = {}): EntryLike => ({
  id: "r1",
  target: { kind: over.kind ?? "group", id: "g1", name: "Comptabilité", hidden: false },
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
  const everyone = levelOptions(may(ALL), "channel", entry({ kind: "everyone" }), "me").map((o) => o.level);
  assert.deepEqual(everyone, ["none", "read", "contribute", "manage"]);
  for (const kind of ["role", "group", "user"] as const) {
    const levels = levelOptions(may(ALL), "channel", entry({ kind }), "me").map((o) => o.level);
    assert.deepEqual(levels, ["read", "contribute", "manage"]);
  }
});

test("only_the_levels_the_viewer_holds_are_offered_and_the_current_one_stays_visible", () => {
  const options = levelOptions(may(["read", "contribute"]), "channel", entry({ level: "manage" }), "me");
  const manage = options.find((o) => o.level === "manage");
  assert.equal(manage?.disabled, true);
  assert.equal(manage?.reason, "not_held");
  assert.deepEqual(options.map((o) => o.level), ["read", "contribute", "manage"]);
});

test("manage_is_disabled_for_a_guest_with_a_reason", () => {
  const options = levelOptions(may(ALL), "channel", entry({ kind: "user", guest: true, level: "read" }), "me");
  const manage = options.find((o) => o.level === "manage");
  assert.equal(manage?.disabled, true);
  assert.equal(manage?.reason, "guest");
  assert.equal(options.find((o) => o.level === "contribute")?.disabled, undefined);
});

test("nobody_edits_a_rule_aimed_at_themselves", () => {
  const mine = entry({ kind: "user" });
  mine.target.id = "me";
  const options = levelOptions(may(ALL), "channel", mine, "me");
  assert.ok(options.every((o) => o.disabled && o.reason === "self"));
  assert.equal(removable(mine, "me"), false);
});

test("a_custom_entry_shows_personalised_and_is_not_selectable", () => {
  const options = levelOptions(may(ALL), "channel", entry({ level: "custom" }), "me");
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
  const inherited = entry({ inheritedFrom: { kind: "folder", id: "f", name: "Compta", hidden: false }, id: undefined });
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
  assert.deepEqual(rows.map((r) => r.target.name), ["Tout", "RH", "Compta", "Marc", "Archive"]);
});
