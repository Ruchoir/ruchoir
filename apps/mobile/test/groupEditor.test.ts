import { test } from "node:test";
import assert from "node:assert/strict";

import { ROLE_COLOURS as GROUP_PASTELS } from "@ruchoir/client/permissionsLogic";
import { groupAbilities, groupColour, groupOpens, pickablePeople, personActions, roleToggleRows, rowLine, settledRoles, togglePayload } from "../src/logic/groupEditor.ts";

type May = { edit: boolean; delete: boolean; changeMembers: boolean; changeRoles: boolean; appoint: boolean; addNeedsLicence: boolean; addPeopleNeedsLicence: boolean };
const ALL: May = { edit: true, delete: true, changeMembers: true, changeRoles: true, appoint: true, addNeedsLicence: false, addPeopleNeedsLicence: false };
const NONE: May = { edit: false, delete: false, changeMembers: false, changeRoles: false, appoint: false, addNeedsLicence: false, addPeopleNeedsLicence: false };
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
  assert.deepEqual(groupAbilities(g, pro), { add: true, addLock: null, rename: false, delete: false, roles: true, rolesEditable: false, managers: true, appointLock: null });
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

test("a_free_or_frozen_space_keeps_the_removals_and_locks_the_additions", () => {
  const paid = { ...ALL, addNeedsLicence: true };
  // Nothing carried: no roles and no managers blocks on the free edition.
  const bare = groupAbilities(group({ may: paid, managerIds: [] }), { licensed: false, frozen: false });
  assert.equal(bare.roles, false);
  assert.equal(bare.managers, false);
  // A group that still carries a role and a manager shows them, to take away.
  const g = group({ may: { ...paid, addPeopleNeedsLicence: true }, roleIds: ["acc"], managerIds: ["julie"] });
  for (const ctx of [{ licensed: false, frozen: false }, { licensed: true, frozen: true }]) {
    const lock = ctx.frozen ? "licence_frozen" : "licence_required";
    const a = groupAbilities(g, ctx);
    assert.equal(a.roles, true);
    assert.equal(a.rolesEditable, true);
    assert.equal(a.managers, true);
    assert.equal(a.addLock, lock);
    assert.equal(a.appointLock, lock);
    // The manager can be taken off, nobody else named.
    assert.deepEqual(personActions(g, { viewerId: "me", ...ctx }, { userId: "julie", role: "member" }), ["remove", "unappoint"]);
    assert.deepEqual(personActions(g, { viewerId: "me", ...ctx }, { userId: "hugo", role: "member" }), ["remove"]);
    // Carried roles switch off, new ones are disabled with the reason.
    const roles = [role("acc", true), role("com", true)];
    const rows = roleToggleRows(g, roles, { myTopRoleId: undefined, editable: a.rolesEditable, additions: lock });
    assert.deepEqual(rows.map((r) => [r.role.id, r.enabled, r.licenceLock]), [["acc", true, null], ["com", false, lock]]);
  }
  // A plain group stays open to new people in a free space.
  assert.equal(groupAbilities(group({ may: paid }), { licensed: false, frozen: false }).addLock, null);
  // A plain group the caller only manages: the server says Add is paid, so the button is locked.
  const managerOnly = group({ may: { ...paid, addPeopleNeedsLicence: true } });
  assert.equal(groupAbilities(managerOnly, { licensed: false, frozen: false }).addLock, "licence_required");
  assert.equal(groupAbilities(managerOnly, { licensed: true, frozen: true }).addLock, "licence_frozen");
  // Paid: nothing locked.
  const full = groupAbilities({ ...g, may: ALL }, pro);
  assert.equal(full.addLock, null);
  assert.equal(full.appointLock, null);
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
  // The licence flag alone is not a right.
  assert.equal(groupOpens(group({ may: { ...NONE, addNeedsLicence: true, addPeopleNeedsLicence: true } }), "above"), false);
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
