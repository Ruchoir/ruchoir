import { test } from "node:test";
import assert from "node:assert/strict";

import { changedPermissions, FAMILIES, memberAccessFor, orderAllowed, permissionRow } from "./rolesLogic.ts";

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
});
