// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionsFor, blockedMoveTargets, canManage, type Entry } from "../src/filesLogic/rights.ts";

const entry = (over: Partial<Entry> & { name: string }): Entry => ({
  id: over.name,
  isFolder: false,
  sizeBytes: 0,
  updatedAt: "2026-10-01T10:00:00Z",
  modifiedBy: "Alice",
  ...over,
});

test("manage rights follow the server: owner, or owner/admin of the space", () => {
  assert.equal(canManage({ ownerId: "me" }, "me", "member"), true);
  assert.equal(canManage({ ownerId: "other" }, "me", "member"), false);
  assert.equal(canManage({ ownerId: "other" }, "me", "admin"), true);
  assert.equal(canManage({ ownerId: "other" }, "me", "owner"), true);
  assert.equal(canManage({ ownerId: "other" }, "me", "guest"), false);
  assert.equal(canManage({}, "me", "member"), false);
  assert.equal(canManage({ ownerId: undefined }, undefined, "member"), false);
});

test("actions with manage rights, in the order of the menu", () => {
  assert.deepEqual(actionsFor(entry({ name: "a.txt" }), true), ["open", "download", "share", "star", "rename", "move", "newVersion", "versions", "details", "delete"]);
  assert.deepEqual(actionsFor(entry({ name: "F", isFolder: true }), true), ["open", "star", "rename", "move", "details", "delete"]);
});

test("actions without manage rights", () => {
  assert.deepEqual(actionsFor(entry({ name: "a.txt" }), false), ["open", "download", "share", "star", "versions", "details"]);
  assert.deepEqual(actionsFor(entry({ name: "F", isFolder: true }), false), ["open", "star", "details"]);
  // An entry the API cannot address has nothing to act on but its details.
  assert.deepEqual(actionsFor(entry({ name: "ghost", id: undefined }), true), ["details"]);
});

test("move targets exclude every folder being moved", () => {
  const blocked = blockedMoveTargets([entry({ name: "F", id: "f", isFolder: true }), entry({ name: "x.txt", id: "x" })]);
  assert.deepEqual([...blocked], ["f"]);
});
