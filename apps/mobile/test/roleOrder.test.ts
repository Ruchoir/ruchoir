import { test } from "node:test";
import assert from "node:assert/strict";

import { canMove, moveRole, orderChanged, rowsOf } from "../src/logic/roleOrder.ts";

type R = { id: string; permissions: string[]; manageable: boolean; systemKey?: "administrator" | "members" | "guests" };
const role = (id: string, manageable: boolean): R => ({ id, permissions: [], manageable });

// Owner and Admin sit above the caller; HR is the caller's highest role (not manageable); the last three are theirs to move.
const ranked = [role("owner", false), role("admin", false), role("hr", false), role("acc", true), role("com", true), role("ops", true)];
const ids = ranked.map((r) => r.id);

test("a_role_moves_up_within_the_band", () => {
  assert.deepEqual(moveRole(ranked, ids, "com", "up"), ["owner", "admin", "hr", "com", "acc", "ops"]);
});

test("a_role_moves_down_within_the_band", () => {
  assert.deepEqual(moveRole(ranked, ids, "acc", "down"), ["owner", "admin", "hr", "com", "acc", "ops"]);
});

test("arrows_are_disabled_at_the_ends_of_the_band", () => {
  assert.equal(canMove(ranked, ids, "acc", "up"), false);
  assert.equal(canMove(ranked, ids, "acc", "down"), true);
  assert.equal(canMove(ranked, ids, "ops", "down"), false);
  assert.equal(canMove(ranked, ids, "ops", "up"), true);
});

test("locked_rows_never_move_and_never_leave_their_place", () => {
  for (const id of ["owner", "admin", "hr"]) {
    assert.equal(canMove(ranked, ids, id, "up"), false);
    assert.equal(canMove(ranked, ids, id, "down"), false);
    assert.deepEqual(moveRole(ranked, ids, id, "down"), ids);
  }
  // Moving the first movable role up cannot pass the caller's own role.
  assert.deepEqual(moveRole(ranked, ids, "acc", "up"), ids);
});

test("down_then_up_again_is_not_a_change", () => {
  const down = moveRole(ranked, ids, "acc", "down");
  assert.equal(orderChanged(ids, down), true);
  assert.equal(orderChanged(ids, moveRole(ranked, down, "acc", "up")), false);
});

test("the_order_sent_is_every_role_strongest_first", () => {
  const next = moveRole(ranked, ids, "ops", "up");
  assert.deepEqual(next, ["owner", "admin", "hr", "acc", "ops", "com"]);
  assert.equal(next.length, ranked.length);
});

test("a_viewer_without_the_right_moves_nothing", () => {
  assert.equal(canMove(ranked, ids, "com", "up", false), false);
  assert.deepEqual(moveRole(ranked, ids, "com", "up", false), ids);
});

test("rows_say_which_are_movable_and_where_the_arrows_stop", () => {
  const rows = rowsOf(ranked, ids, true);
  assert.deepEqual(rows.map((r) => [r.id, r.movable, r.up, r.down]), [
    ["owner", false, false, false],
    ["admin", false, false, false],
    ["hr", false, false, false],
    ["acc", true, false, true],
    ["com", true, true, true],
    ["ops", true, true, false],
  ]);
});
