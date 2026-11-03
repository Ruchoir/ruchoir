import assert from "node:assert/strict";
import { test } from "node:test";
import { groupHitsFor, offersLeaving, offersManagement, removalOf, type PanelGroup } from "./groupPanelLogic.ts";

const group = (over: Partial<PanelGroup> = {}): PanelGroup => ({
  id: "g1",
  name: "Comptabilité",
  source: "manual",
  memberIds: ["julie", "hugo", "camille", "me"],
  managerIds: ["julie", "camille"],
  roleIds: [],
  may: { changeMembers: false, appoint: false },
  ...over,
});

test("the_panel_offers_management_to_managers_only", () => {
  assert.equal(offersManagement(group(), "julie"), true);
  assert.equal(offersManagement(group(), "hugo"), false);
  // Whoever changes members space-wide gets it without managing the group.
  assert.equal(offersManagement(group({ may: { changeMembers: true, appoint: false } }), "hugo"), true);
  // A directory group is changed in the directory.
  assert.equal(offersManagement(group({ source: "directory", may: { changeMembers: true, appoint: true } }), "julie"), false);

  // A manager cannot take out another manager, can take out anyone else, and leaves through the button.
  assert.deepEqual(removalOf(group(), "julie", "camille"), { removable: false, reason: "manager_protected" });
  assert.deepEqual(removalOf(group(), "julie", "hugo"), { removable: true });
  assert.deepEqual(removalOf(group(), "julie", "julie"), { removable: false, reason: "self" });
  // Unless they may appoint.
  assert.deepEqual(removalOf(group({ may: { changeMembers: true, appoint: true } }), "julie", "camille"), { removable: true });
  // Changing members without managing is not held by the protection.
  assert.deepEqual(removalOf(group({ may: { changeMembers: true, appoint: false } }), "me", "camille"), { removable: true });

  assert.equal(offersLeaving(group(), "hugo"), true);
  assert.equal(offersLeaving(group(), "stranger"), false);
  assert.equal(offersLeaving(group({ source: "directory" }), "hugo"), false);
});

test("a_guest_gets_no_group_hits", () => {
  const groups = [group()];
  assert.deepEqual(groupHitsFor("guest", groups, "", ["julie"]), []);
  const hits = groupHitsFor("member", groups, "compta", ["julie", "hugo"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].members, 4);
  assert.equal(hits[0].inRoom, 2);
});
