import { test } from "node:test";
import assert from "node:assert/strict";

import { rightsOf, spaceGates } from "./spaceGates.ts";

test("a_custom_role_opens_what_its_rights_open_and_nothing_else", () => {
  // Karim: a member whose "Ressources humaines" role manages people and roles.
  const hr = spaceGates("member", ["members.view", "members.invite", "members.manage", "roles.manage", "audit.view"]);
  assert.equal(hr.openSettings, true);
  assert.equal(hr.invite, true);
  assert.equal(hr.managePeople, true);
  assert.equal(hr.readAudit, true);
  assert.equal(hr.setDefaultChannel, false, "space.settings is not his");
  assert.equal(hr.deleteChannels, false);
  // A plain member administers nothing.
  const plain = spaceGates("member", ["members.view", "channels.create"]);
  assert.equal(plain.openSettings, false);
  assert.equal(plain.invite, false);
  // The owner always reaches the settings: the space's identity is theirs alone.
  assert.equal(spaceGates("owner", []).openSettings, true);
});

test("an_instance_without_permissions_falls_back_on_the_role", () => {
  assert.ok(rightsOf({ role: "admin" }).includes("channels.delete"));
  assert.deepEqual(rightsOf({ role: "member" }), []);
  assert.deepEqual(rightsOf({ role: "member", myPermissions: ["dm.start"] }), ["dm.start"]);
  assert.deepEqual(rightsOf(undefined), []);
});
