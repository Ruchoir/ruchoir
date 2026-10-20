import { test } from "node:test";
import assert from "node:assert/strict";

import { channelRank, grantableChannelRoles } from "../src/logic/channelRoles.ts";

test("an_owner_hands_out_the_roles_below_it", () => {
  assert.deepEqual(grantableChannelRoles("owner", "member"), ["member", "admin"]);
  assert.deepEqual(grantableChannelRoles("owner", "admin"), ["member", "admin"]);
});

test("nobody_reaches_their_equal_or_above", () => {
  assert.deepEqual(grantableChannelRoles("admin", "admin"), []);
  assert.deepEqual(grantableChannelRoles("admin", "owner"), []);
  assert.deepEqual(grantableChannelRoles("member", "member"), []);
});

test("a_moderator_only_hands_out_member", () => {
  assert.deepEqual(grantableChannelRoles("admin", "member"), ["member"]);
});

test("an_unknown_role_authorises_nothing", () => {
  assert.equal(channelRank("guest"), 0);
  assert.deepEqual(grantableChannelRoles("guest", "member"), []);
});
