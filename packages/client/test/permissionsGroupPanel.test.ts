// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import assert from "node:assert/strict";
import { test } from "node:test";
import { addBlockFor, groupHitsFor, guestCeilingApplies, offersLeaving, offersManagement, removalOf, type PanelGroup } from "../src/permissionsLogic/groupPanel.ts";

const group = (over: Partial<PanelGroup> = {}): PanelGroup => ({
  id: "g1",
  name: "Comptabilité",
  source: "manual",
  memberIds: ["julie", "hugo", "camille", "me"],
  managerIds: ["julie", "camille"],
  roleIds: [],
  may: { changeMembers: true, appoint: false },
  ...over,
});

test("the_panel_offers_management_where_the_server_lets_members_change", () => {
  assert.equal(offersManagement(group()), true);
  // A frozen licence or no right: the server's `may` says no, managers included.
  assert.equal(offersManagement(group({ may: { changeMembers: false, appoint: false } })), false);
  // A directory group is changed in the directory.
  assert.equal(offersManagement(group({ source: "directory", may: { changeMembers: true, appoint: true } })), false);
});

test("removal_follows_what_the_server_allows", () => {
  // A manager cannot take out another manager, can take out anyone else, and leaves through the button.
  assert.deepEqual(removalOf(group(), "julie", "camille"), { removable: false, reason: "manager_protected" });
  assert.deepEqual(removalOf(group(), "julie", "hugo"), { removable: true });
  assert.deepEqual(removalOf(group(), "julie", "julie"), { removable: false, reason: "self" });
  // Unless they may appoint.
  assert.deepEqual(removalOf(group({ may: { changeMembers: true, appoint: true } }), "julie", "camille"), { removable: true });
  // Changing members without managing is not held by the protection.
  assert.deepEqual(removalOf(group(), "me", "camille"), { removable: true });
  // No right to change members (frozen licence, nothing space-wide): nothing is offered.
  const frozen = group({ may: { changeMembers: false, appoint: false } });
  assert.deepEqual(removalOf(frozen, "julie", "hugo"), { removable: false, reason: "forbidden" });
  assert.deepEqual(removalOf(frozen, "julie", "julie"), { removable: false, reason: "self" });
  // A directory group is changed in the directory.
  assert.deepEqual(removalOf(group({ source: "directory" }), "julie", "hugo"), { removable: false, reason: "directory" });

  assert.equal(offersLeaving(group(), "hugo"), true);
  assert.equal(offersLeaving(group(), "stranger"), false);
  assert.equal(offersLeaving(group({ source: "directory" }), "hugo"), false);
});

test("nobody_ticks_themselves_into_a_group_that_carries_roles", () => {
  const ctx = { carriesRoles: true, viewerId: "me", viewerIsOwner: false };
  assert.equal(addBlockFor(ctx, "me"), "self_role");
  assert.equal(addBlockFor(ctx, "hugo"), null);
  // An owner may; so may anyone joining a group without roles.
  assert.equal(addBlockFor({ ...ctx, viewerIsOwner: true }, "me"), null);
  assert.equal(addBlockFor({ ...ctx, carriesRoles: false }, "me"), null);
});

test("guests_get_the_ceiling_line_only_when_roles_are_carried", () => {
  const people = [
    { userId: "lucie", role: "guest" },
    { userId: "hugo", role: "member" },
  ];
  assert.equal(guestCeilingApplies(people, new Set(["lucie"]), true), true);
  assert.equal(guestCeilingApplies(people, new Set(["hugo"]), true), false);
  assert.equal(guestCeilingApplies(people, new Set(["lucie"]), false), false);
  assert.equal(guestCeilingApplies(people, new Set(), true), false);
});

test("a_guest_gets_no_group_hits", () => {
  const groups = [group()];
  assert.deepEqual(groupHitsFor("guest", groups, "", ["julie"]), []);
  const hits = groupHitsFor("member", groups, "compta", ["julie", "hugo"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].members, 4);
  assert.equal(hits[0].inRoom, 2);
});
