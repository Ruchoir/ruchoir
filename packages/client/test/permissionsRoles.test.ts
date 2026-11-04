// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";

import { changedPermissions, FAMILIES, grantableRoles, holdsEverything, memberAccessFor, orderAllowed, permissionRow, roleIdsToSave, roleRowState } from "../src/permissionsLogic/roles.ts";
import { groupsOf, holdsRole, rolePeople, rolesViaGroups, type GroupLike } from "../src/permissionsLogic/groups.ts";

const role = (id: string, over: Partial<{ systemKey: "administrator" | "members" | "guests"; permissions: string[]; manageable: boolean; position: number }> = {}) => ({
  id,
  name: id,
  position: over.position ?? 1,
  permissions: over.permissions ?? [],
  holders: 0,
  manageable: over.manageable ?? true,
  systemKey: over.systemKey,
});

test("every_permission_of_the_catalogue_sits_in_one_family", () => {
  const all = FAMILIES.flatMap((f) => f.permissions);
  assert.equal(all.length, 29);
  assert.equal(new Set(all).size, 29);
  // "Tous les droits" is said only of a role holding every one of them.
  assert.equal(holdsEverything({ permissions: all }), true);
  assert.equal(holdsEverything({ permissions: all.slice(1) }), false);
});

test("a_row_is_locked_when_the_viewer_lacks_the_permission", () => {
  const r = role("com", { permissions: ["message.manage"] });
  const viewer = ["members.invite", "channels.create"];
  const members = ["channels.create"];
  assert.deepEqual(permissionRow("message.manage", { role: r, draft: new Set(r.permissions), viewerRights: viewer, membersBase: members }), {
    on: true, locked: true, changed: false, givenByMembers: false,
  });
  assert.deepEqual(permissionRow("members.invite", { role: r, draft: new Set(["message.manage", "members.invite"]), viewerRights: viewer, membersBase: members }), {
    on: true, locked: false, changed: true, givenByMembers: false,
  });
  assert.equal(permissionRow("channels.create", { role: r, draft: new Set(), viewerRights: viewer, membersBase: members }).givenByMembers, true);
  // @members itself never says "already given by @members".
  const base = role("m", { systemKey: "members", permissions: ["channels.create"] });
  assert.equal(permissionRow("channels.create", { role: base, draft: new Set(base.permissions), viewerRights: viewer, membersBase: members }).givenByMembers, false);
  // Nor does @invités: a guest never holds what @members gives.
  const guests = role("g", { systemKey: "guests" });
  assert.equal(permissionRow("channels.create", { role: guests, draft: new Set(), viewerRights: viewer, membersBase: members }).givenByMembers, false);
});

test("changes_are_counted_both_ways", () => {
  assert.deepEqual(changedPermissions(["a", "b"], ["b", "c"]), { added: ["c"], removed: ["a"] });
  assert.deepEqual(changedPermissions(["a"], ["a"]), { added: [], removed: [] });
});

test("an_order_keeps_what_the_viewer_cannot_move_in_place", () => {
  const roles = [role("admin", { manageable: false, position: 4 }), role("hr", { manageable: false, position: 3 }), role("compta", { position: 2 }), role("com", { position: 1 })];
  assert.equal(orderAllowed(roles, ["admin", "hr", "com", "compta"]), true);
  assert.equal(orderAllowed(roles, ["admin", "compta", "hr", "com"]), false);
  assert.equal(orderAllowed(roles, ["hr", "admin", "compta", "com"]), false);
  assert.equal(orderAllowed(roles, ["admin", "hr", "compta"]), false, "every role, once");
});

test("the_gestion_tab_offers_what_the_viewer_may_do", () => {
  const roles = [role("admin", { systemKey: "administrator", manageable: false }), role("hr", { manageable: false }), role("compta"), role("members", { systemKey: "members" }), role("guests", { systemKey: "guests" })];
  const hugo = { userId: "hugo", roleIds: ["compta"], manageable: true };
  const access = memberAccessFor({ member: hugo, me: "karim", edition: "enterprise", roles });
  assert.equal(access.mode, "roles");
  if (access.mode === "roles") {
    assert.deepEqual(access.choices.map((c) => [c.role.id, c.checked, c.disabled]), [["admin", false, true], ["hr", false, true], ["compta", true, false]]);
  }
  assert.equal(memberAccessFor({ member: hugo, me: "karim", edition: "community", roles }).mode, "fixed");
  assert.equal(memberAccessFor({ member: hugo, me: "karim", edition: "frozen", roles }).mode, "frozen");
  assert.equal(memberAccessFor({ member: { ...hugo, manageable: false }, me: "karim", edition: "enterprise", roles }).mode, "above");
  assert.equal(memberAccessFor({ member: hugo, me: "hugo", edition: "enterprise", roles }).mode, "none");
  // Managing people without managing roles: the roles are read, not ticked.
  assert.equal(memberAccessFor({ member: hugo, me: "karim", edition: "enterprise", roles, rights: ["members.manage"] }).mode, "held");
  assert.equal(memberAccessFor({ member: hugo, me: "karim", edition: "enterprise", roles, rights: ["roles.manage"] }).mode, "roles");
});

test("the_legacy_roles_one_may_hand_out_stay_below_ones_own", () => {
  assert.deepEqual(grantableRoles("admin", "member"), ["guest", "member"]);
  assert.deepEqual(grantableRoles("owner", "admin"), ["guest", "member", "admin", "owner"]);
  assert.deepEqual(grantableRoles("admin", "admin"), [], "nobody acts on an equal");
  assert.deepEqual(grantableRoles("member", "guest"), ["guest"]);
});

test("a_row_of_the_roles_list_says_why_it_cannot_be_opened", () => {
  const admin = role("a", { systemKey: "administrator", manageable: false });
  const hr = role("hr", { manageable: false });
  const compta = role("c");
  const members = role("m", { systemKey: "members" });
  assert.equal(roleRowState(admin, { myTopRoleId: "hr", frozen: false }), "above");
  assert.equal(roleRowState(hr, { myTopRoleId: "hr", frozen: false }), "mine");
  assert.equal(roleRowState(compta, { myTopRoleId: "hr", frozen: false }), "edit");
  assert.equal(roleRowState(members, { myTopRoleId: "hr", frozen: false }), "edit");
  assert.equal(roleRowState(compta, { myTopRoleId: "hr", frozen: true }), "frozen");
  // The owner manages Administrator: a system role, tuned like any other (spec: editable, not
  // deletable).
  assert.equal(roleRowState({ ...admin, manageable: true }, { frozen: false }), "edit");
});

const group = (id: string, name: string, memberIds: string[], roleIds: string[]): GroupLike => ({ id, name, source: "manual", memberIds, managerIds: [], roleIds });

test("a_role_received_through_a_group_is_not_removable_here", () => {
  const roles = [role("compta"), role("com"), role("hr")];
  const groups = [group("g1", "Comptabilite", ["hugo"], ["compta", "com"]), group("g2", "Communication", ["hugo"], ["com"])];
  const hugo = { userId: "hugo", roleIds: ["com"], manageable: true };
  const access = memberAccessFor({ member: hugo, me: "karim", edition: "enterprise", roles, viaGroups: rolesViaGroups(hugo, groups) });
  assert.equal(access.mode, "roles");
  if (access.mode === "roles") {
    // compta: only through a group, so ticked and locked; com: direct and through groups, a normal box; hr: untouched.
    assert.deepEqual(
      access.choices.map((c) => [c.role.id, c.checked, c.disabled, c.direct, c.via]),
      [["compta", true, true, false, ["Comptabilite"]], ["com", true, false, true, ["Comptabilite", "Communication"]], ["hr", false, false, false, []]],
    );
  }
});

test("saving_sends_only_direct_role_ids", () => {
  const roles = [role("compta"), role("com"), role("hr")];
  const groups = [group("g1", "Comptabilite", ["hugo"], ["compta"])];
  const hugo = { userId: "hugo", roleIds: ["com"], manageable: true };
  const access = memberAccessFor({ member: hugo, me: "karim", edition: "enterprise", roles, viaGroups: rolesViaGroups(hugo, groups) });
  assert.equal(access.mode, "roles");
  if (access.mode !== "roles") return;
  // Even a draft that somehow holds the group-received role never sends it.
  assert.deepEqual(roleIdsToSave(roles, access.choices, new Set(["com", "compta", "hr"])), ["com", "hr"]);
  assert.deepEqual(roleIdsToSave(roles, access.choices, new Set(["com"])), ["com"]);
});

test("the_role_people_tab_lists_groups_apart", () => {
  const members = [
    { userId: "nadia", name: "Nadia", roleIds: ["compta"] },
    { userId: "julie", name: "Julie", roleIds: [] },
    { userId: "hugo", name: "Hugo", roleIds: ["compta"] },
    { userId: "paul", name: "Paul", roleIds: [] },
  ];
  const groups = [group("g1", "Comptabilite", ["julie", "hugo"], ["compta"]), group("g2", "Autre", ["paul"], ["com"]), group("g3", "Anciens", [], ["compta"])];
  const people = rolePeople("compta", members, groups);
  assert.deepEqual(people.direct.map((m) => m.userId), ["nadia", "hugo"]);
  assert.deepEqual(people.viaGroups.map((v) => [v.group.id, v.members.map((m) => m.userId)]), [["g3", []], ["g1", ["julie", "hugo"]]]);
  // A person who has it both ways is listed in both places.
  assert.equal(people.direct.some((m) => m.userId === "hugo"), true);
  // Everyone who holds it, once.
  assert.deepEqual(people.holderIds.sort(), ["hugo", "julie", "nadia"]);
});

test("a_person_groups_are_those_they_are_in_by_name", () => {
  const groups = [group("g2", "Zeta", ["a"], []), group("g1", "alpha", ["a", "b"], []), group("g3", "Other", ["b"], [])];
  assert.deepEqual(groupsOf("a", groups).map((g) => g.id), ["g1", "g2"]);
});

test("the_role_filter_matches_direct_and_group_roles", () => {
  const groups = [group("g1", "Comptabilite", ["hugo"], ["compta"])];
  assert.equal(holdsRole({ userId: "nadia", roleIds: ["compta"] }, "compta", groups), true, "direct");
  assert.equal(holdsRole({ userId: "hugo", roleIds: [] }, "compta", groups), true, "through a group");
  assert.equal(holdsRole({ userId: "paul", roleIds: ["com"] }, "compta", groups), false, "neither");
});
