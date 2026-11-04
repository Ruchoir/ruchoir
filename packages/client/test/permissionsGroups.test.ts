// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";

import { groupMentionHits, groupPeople, groupRow, rolesViaGroups, selfRoleKey, sortGroups } from "../src/permissionsLogic/groups.ts";

const group = (id: string, name: string, over: Partial<{ memberIds: string[]; managerIds: string[]; roleIds: string[]; source: "manual" | "directory" }> = {}) => ({
  id,
  name,
  source: over.source ?? ("manual" as const),
  memberIds: over.memberIds ?? [],
  managerIds: over.managerIds ?? [],
  roleIds: over.roleIds ?? [],
});

const role = (id: string, manageable = true) => ({ id, name: id, position: 1, permissions: [], holders: 0, manageable });

test("roles_via_groups_names_every_source_group", () => {
  const groups = [
    group("g1", "Comptabilité", { memberIds: ["u1", "u2"], roleIds: ["accountant"] }),
    group("g2", "Direction", { memberIds: ["u1"], roleIds: ["accountant", "admin"] }),
    group("g3", "Chantier", { memberIds: ["u2"], roleIds: ["site"] }),
  ];
  const via = rolesViaGroups({ userId: "u1" }, groups);
  assert.deepEqual([...via.keys()].sort(), ["accountant", "admin"]);
  assert.deepEqual(via.get("accountant"), ["Comptabilité", "Direction"]);
  assert.deepEqual(via.get("admin"), ["Direction"]);
  assert.equal(rolesViaGroups({ userId: "nobody" }, groups).size, 0);
});

test("a_group_carrying_a_role_above_you_is_locked", () => {
  const roles = [role("admin", false), role("accountant")];
  const row = groupRow(group("g", "Direction", { roleIds: ["admin"] }), roles, { frozen: false });
  assert.equal(row.locked, "above");
  assert.deepEqual(row.carries.map((r) => r.id), ["admin"]);
  assert.equal(groupRow(group("g", "Compta", { roleIds: ["accountant"] }), roles, { frozen: false }).locked, null);
});

test("a_frozen_space_locks_only_groups_that_carry_roles", () => {
  const roles = [role("accountant")];
  assert.equal(groupRow(group("g", "Compta", { roleIds: ["accountant"] }), roles, { frozen: true }).locked, "frozen");
  assert.equal(groupRow(group("g", "Chantier"), roles, { frozen: true }).locked, null);
  // A role the viewer does not manage reads as "above" before "frozen".
  assert.equal(groupRow(group("g", "D", { roleIds: ["x"] }), [role("x", false)], { frozen: true }).locked, "above");
});

test("mention_hits_count_the_members_in_the_room", () => {
  const groups = [
    group("g1", "Comptabilité", { memberIds: ["u1", "u2", "u3"] }),
    group("g2", "Communication", { memberIds: ["u4"] }),
    group("g3", "Chantier", { memberIds: ["u1"] }),
  ];
  const hits = groupMentionHits(groups, "com", ["u1", "u2", "u9"]);
  assert.deepEqual(hits.map((h) => [h.group.name, h.members, h.inRoom]), [
    ["Communication", 1, 0],
    ["Comptabilité", 3, 2],
  ]);
  // Accents and case do not matter; an empty query lists every group in order.
  assert.equal(groupMentionHits(groups, "COMPTABILITE", []).length, 1);
  assert.deepEqual(groupMentionHits(groups, "", []).map((h) => h.group.name), ["Chantier", "Communication", "Comptabilité"]);
});

test("groups_sort_by_name_ignoring_accents_and_case", () => {
  const sorted = sortGroups([group("1", "été"), group("2", "Zoé"), group("3", "Alpha")]);
  assert.deepEqual(sorted.map((g) => g.name), ["Alpha", "été", "Zoé"]);
});

test("people_of_a_group_counts_those_drawn_and_those_gone", () => {
  const members = [{ userId: "a" }, { userId: "b" }];
  const got = groupPeople({ memberIds: ["a", "gone", "b", "gone2"] }, members);
  assert.deepEqual(got.people.map((m) => m.userId), ["a", "b"]);
  assert.equal(got.missing, 2);
  assert.equal(groupPeople({ memberIds: [] }, members).missing, 0);
});

test("the_self_role_refusal_speaks_of_roles_or_of_joining", () => {
  assert.equal(selfRoleKey("roles"), "groups.noSelfRole");
  assert.equal(selfRoleKey("members"), "groups.noSelfJoin");
});
