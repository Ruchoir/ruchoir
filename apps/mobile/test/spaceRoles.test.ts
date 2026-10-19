import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canAdminister,
  canDeleteSpace,
  canEditIdentity,
  grantableRoles,
  matchesMember,
  memberCounts,
  nameConfirmed,
} from "../src/logic/spaceRoles.ts";

test("only_someone_ranked_below_can_be_changed", () => {
  assert.deepEqual(grantableRoles("admin", "admin"), []);
  assert.deepEqual(grantableRoles("admin", "owner"), []);
  assert.deepEqual(grantableRoles("member", "guest"), ["guest"]);
  assert.deepEqual(grantableRoles("guest", "guest"), []);
});

test("an_admin_hands_out_ranks_below_their_own", () => {
  assert.deepEqual(grantableRoles("admin", "member"), ["guest", "member"]);
  assert.deepEqual(grantableRoles("admin", "guest"), ["guest", "member"]);
});

test("the_owner_may_also_hand_the_space_over", () => {
  assert.deepEqual(grantableRoles("owner", "admin"), ["guest", "member", "admin", "owner"]);
});

test("an_unknown_role_authorises_nothing", () => {
  assert.deepEqual(grantableRoles("superuser", "guest"), []);
  assert.deepEqual(grantableRoles("owner", "superuser"), ["guest", "member", "admin", "owner"]);
});

test("who_may_do_what", () => {
  assert.equal(canAdminister("owner"), true);
  assert.equal(canAdminister("admin"), true);
  assert.equal(canAdminister("member"), false);
  assert.equal(canAdminister(undefined), false);
  assert.equal(canEditIdentity("owner"), true);
  assert.equal(canEditIdentity("admin"), false);
  assert.equal(canDeleteSpace("owner"), true);
  assert.equal(canDeleteSpace("admin"), false);
});

test("the_summary_counts_people_guests_and_bots_apart", () => {
  const counts = memberCounts([
    { role: "owner", bot: false },
    { role: "member", bot: false },
    { role: "guest", bot: false },
    { role: "member", bot: true },
  ]);
  assert.deepEqual(counts, { people: 3, guests: 1, bots: 1 });
});

test("the_search_ignores_case_and_accents", () => {
  assert.equal(matchesMember({ name: "Hélène Durand" }, "helene"), true);
  assert.equal(matchesMember({ name: "Hélène Durand" }, "  DUR "), true);
  assert.equal(matchesMember({ name: "Hélène Durand" }, "bob"), false);
  assert.equal(matchesMember({ name: "Bob" }, ""), true);
});

test("deleting_takes_the_space_name_typed_exactly", () => {
  assert.equal(nameConfirmed("Atelier Lumen", "Atelier Lumen"), true);
  assert.equal(nameConfirmed("  Atelier Lumen ", "Atelier Lumen"), true);
  assert.equal(nameConfirmed("atelier lumen", "Atelier Lumen"), false);
  assert.equal(nameConfirmed("", "Atelier Lumen"), false);
});
