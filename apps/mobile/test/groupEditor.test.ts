import { test } from "node:test";
import assert from "node:assert/strict";

import { GROUP_PASTELS, groupAbilities, groupColour, groupOpens, pickablePeople, personActions, roleToggleRows, rowLine, settledRoles, togglePayload } from "../src/logic/groupEditor.ts";

type May = { edit: boolean; delete: boolean; changeMembers: boolean; changeRoles: boolean; appoint: boolean };
const ALL: May = { edit: true, delete: true, changeMembers: true, changeRoles: true, appoint: true };
const NONE: May = { edit: false, delete: false, changeMembers: false, changeRoles: false, appoint: false };
const group = (over: Partial<{ source: "manual" | "directory"; memberIds: string[]; managerIds: string[]; roleIds: string[]; may: May }> = {}) => ({
  id: "g1",
  name: "Comptabilité",
  source: "manual" as const,
  memberIds: ["me", "julie", "hugo"],
  managerIds: ["julie"],
  roleIds: [],
  may: ALL,
  ...over,
});
const pro = { licensed: true, frozen: false };
const role = (id: string, manageable: boolean, systemKey?: "administrator" | "members" | "guests") => ({ id, name: id, permissions: [], manageable, systemKey });

test("a_manager_who_only_changes_members_sees_only_those_actions", () => {
  const g = group({ may: { ...NONE, changeMembers: true } });
  assert.deepEqual(groupAbilities(g, pro), { add: true, rename: false, delete: false, roles: true, rolesEditable: false, managers: true });
  assert.deepEqual(personActions(g, { viewerId: "me", ...pro }, { userId: "hugo", role: "member" }), ["remove"]);
});

test("a_person_row_offers_remove_and_appoint_by_may", () => {
  assert.deepEqual(personActions(group(), { viewerId: "me", ...pro }, { userId: "hugo", role: "member" }), ["remove", "appoint"]);
  assert.deepEqual(personActions(group(), { viewerId: "me", ...pro }, { userId: "julie", role: "member" }), ["remove", "unappoint"]);
  assert.deepEqual(personActions(group({ may: { ...ALL, appoint: false } }), { viewerId: "me", ...pro }, { userId: "hugo", role: "member" }), ["remove"]);
});

test("one_does_not_remove_oneself_and_a_guest_is_never_appointed", () => {
  assert.deepEqual(personActions(group(), { viewerId: "me", ...pro }, { userId: "me", role: "member" }), ["appoint"]);
  assert.deepEqual(personActions(group(), { viewerId: "me", ...pro }, { userId: "hugo", role: "guest" }), ["remove"]);
});

test("a_manager_cannot_remove_another_manager_without_appoint", () => {
  const g = group({ managerIds: ["me", "julie"], may: { ...ALL, appoint: false } });
  assert.deepEqual(personActions(g, { viewerId: "me", ...pro }, { userId: "julie", role: "member" }), []);
});

test("a_directory_group_changes_neither_people_nor_managers", () => {
  const g = group({ source: "directory" });
  assert.deepEqual(personActions(g, { viewerId: "me", ...pro }, { userId: "hugo", role: "member" }), []);
  const a = groupAbilities(g, pro);
  assert.equal(a.add, false);
  assert.equal(a.managers, false);
  // The roles it carries stay editable, as on the web.
  assert.equal(a.rolesEditable, true);
});

test("community_has_no_roles_and_no_managers_and_frozen_locks_them", () => {
  const community = groupAbilities(group(), { licensed: false, frozen: false });
  assert.equal(community.roles, false);
  assert.equal(community.managers, false);
  const frozen = groupAbilities(group(), { licensed: true, frozen: true });
  assert.equal(frozen.rolesEditable, false);
  assert.deepEqual(personActions(group(), { viewerId: "me", licensed: true, frozen: true }, { userId: "hugo", role: "member" }), ["remove"]);
});

test("delete_and_rename_follow_may", () => {
  const a = groupAbilities(group({ may: { ...NONE, edit: true } }), pro);
  assert.equal(a.rename, true);
  assert.equal(a.delete, false);
  assert.equal(groupAbilities(group({ may: { ...NONE, delete: true } }), pro).delete, true);
});

test("the_row_line_counts_people_and_names_the_roles_it_carries", () => {
  assert.deepEqual(rowLine(3, ["Comptable"], true), [
    { key: "conversation.people", vars: { count: 3 } },
    { key: "groups.carries", vars: { roles: "Comptable" } },
  ]);
  assert.deepEqual(rowLine(4, [], true), [{ key: "conversation.people", vars: { count: 4 } }, { key: "groups.noRoleLine" }]);
  assert.deepEqual(rowLine(2, ["A", "B"], true)[1], { key: "groups.carries", vars: { roles: "A, B" } });
  assert.deepEqual(rowLine(2, ["A"], false), [{ key: "conversation.people", vars: { count: 2 } }]);
});

test("a_row_opens_unless_it_is_locked_above_with_nothing_allowed", () => {
  assert.equal(groupOpens(group({ may: NONE }), "above"), false);
  assert.equal(groupOpens(group({ may: { ...NONE, changeMembers: true } }), "above"), true);
  assert.equal(groupOpens(group({ may: NONE }), null), true);
});

test("pickable_people_are_those_not_already_in_and_not_bots", () => {
  const members = [
    { userId: "me", name: "Moi" },
    { userId: "julie", name: "Julie" },
    { userId: "lea", name: "Léa" },
    { userId: "bot", name: "Bot", bot: true },
  ];
  const ids = (list: { userId: string }[]) => list.map((m) => m.userId);
  assert.deepEqual(ids(pickablePeople(members, group({ memberIds: ["julie"] }), { carriesRoles: false, viewerId: "me", viewerIsOwner: false })), ["me", "lea"]);
});

test("nobody_picks_themselves_into_a_group_that_carries_roles_unless_owner", () => {
  const members = [
    { userId: "me", name: "Moi" },
    { userId: "lea", name: "Léa" },
  ];
  const g = group({ memberIds: [] });
  assert.deepEqual(pickablePeople(members, g, { carriesRoles: true, viewerId: "me", viewerIsOwner: false }).map((m) => m.userId), ["lea"]);
  assert.deepEqual(pickablePeople(members, g, { carriesRoles: true, viewerId: "me", viewerIsOwner: true }).map((m) => m.userId), ["me", "lea"]);
});

test("role_toggles_skip_base_roles_and_lock_those_above_with_the_reason", () => {
  const roles = [role("admin", false), role("hr", false), role("acc", true), role("members", true, "members"), role("guests", true, "guests")];
  const rows = roleToggleRows(group({ roleIds: ["acc"] }), roles, { myTopRoleId: "hr", editable: true });
  assert.deepEqual(
    rows.map((r) => [r.role.id, r.on, r.lock, r.enabled]),
    [
      ["admin", false, "above", false],
      ["hr", false, "yourTop", false],
      ["acc", true, null, true],
    ],
  );
});

test("role_toggles_are_all_off_when_the_group_may_not_change_roles", () => {
  const rows = roleToggleRows(group(), [role("acc", true)], { myTopRoleId: undefined, editable: false });
  assert.equal(rows[0].enabled, false);
});

test("a_toggle_sends_the_whole_list_strongest_first_keeping_locked_roles", () => {
  const roles = [role("admin", false), role("hr", false), role("acc", true), role("com", true)];
  assert.deepEqual(togglePayload(group({ roleIds: ["admin"] }), roles, "com", true), ["admin", "com"]);
  assert.deepEqual(togglePayload(group({ roleIds: ["admin", "acc", "com"] }), roles, "acc", false), ["admin", "com"]);
});

test("a_group_keeps_the_same_pastel_everywhere", () => {
  assert.equal(groupColour("abc"), groupColour("abc"));
  assert.ok((GROUP_PASTELS as readonly string[]).includes(groupColour("0f3c-77")));
});

test("a_locked_role_the_group_already_holds_survives_any_toggle", () => {
  const roles = [role("admin", false), role("hr", false), role("acc", true), role("com", true)];
  // Turning another role on and off never drops the locked ones the group carries.
  assert.deepEqual(togglePayload(group({ roleIds: ["admin", "hr"] }), roles, "acc", true), ["admin", "hr", "acc"]);
  assert.deepEqual(togglePayload(group({ roleIds: ["admin", "hr", "acc"] }), roles, "acc", false), ["admin", "hr"]);
  assert.deepEqual(togglePayload(group({ roleIds: ["hr"] }), roles, "hr", true), ["hr"]);
});

test("a_toggle_stays_where_it_was_put_until_the_reloaded_roles_agree", () => {
  assert.deepEqual(settledRoles(["a", "b"], ["a"]), ["a", "b"]);
  assert.equal(settledRoles(["a", "b"], ["b", "a"]), null);
  assert.equal(settledRoles(null, ["a"]), null);
});
