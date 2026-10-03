// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionsFor,
  blockedMoveTargets,
  canManage,
  filterEntries,
  middleTruncate,
  rangeBetween,
  sortEntries,
  type Entry,
} from "./model.ts";

const entry = (over: Partial<Entry> & { name: string }): Entry => ({
  id: over.name,
  isFolder: false,
  sizeBytes: 0,
  updatedAt: "2026-10-01T10:00:00Z",
  modifiedBy: "Alice",
  ...over,
});

const names = (rows: Entry[]) => rows.map((r) => r.name);

test("sort keeps folders first, whatever the key and direction", () => {
  const rows = [
    entry({ name: "b.txt", sizeBytes: 10 }),
    entry({ name: "Zeta", isFolder: true, childCount: 1 }),
    entry({ name: "a.txt", sizeBytes: 30 }),
    entry({ name: "alpha", isFolder: true, childCount: 5 }),
  ];
  assert.deepEqual(names(sortEntries(rows, { key: "name", dir: "asc" })), ["alpha", "Zeta", "a.txt", "b.txt"]);
  assert.deepEqual(names(sortEntries(rows, { key: "name", dir: "desc" })), ["Zeta", "alpha", "b.txt", "a.txt"]);
  // A folder's size is its number of entries.
  assert.deepEqual(names(sortEntries(rows, { key: "size", dir: "desc" })), ["alpha", "Zeta", "a.txt", "b.txt"]);
});

test("sort orders numbers in names the way people count", () => {
  const rows = [entry({ name: "Facture 10.pdf" }), entry({ name: "Facture 9.pdf" }), entry({ name: "facture 2.pdf" })];
  assert.deepEqual(names(sortEntries(rows, { key: "name", dir: "asc" })), ["facture 2.pdf", "Facture 9.pdf", "Facture 10.pdf"]);
});

test("sort by date breaks ties on the name, and does not touch its input", () => {
  const rows = [
    entry({ name: "b", updatedAt: "2026-10-02T09:00:00Z" }),
    entry({ name: "a", updatedAt: "2026-10-02T09:00:00Z" }),
    entry({ name: "c", updatedAt: "2026-09-01T09:00:00Z" }),
  ];
  const before = names(rows);
  assert.deepEqual(names(sortEntries(rows, { key: "updatedAt", dir: "desc" })), ["a", "b", "c"]);
  assert.deepEqual(names(rows), before);
});

test("filter ignores case and accents", () => {
  const rows = [entry({ name: "Récapitulatif.docx" }), entry({ name: "Budget.xlsx" })];
  assert.deepEqual(names(filterEntries(rows, "recap")), ["Récapitulatif.docx"]);
  assert.deepEqual(names(filterEntries(rows, "  BUDGET ")), ["Budget.xlsx"]);
  assert.equal(filterEntries(rows, "").length, 2);
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

test("range selection uses visible order, in either direction", () => {
  const order = ["a", "b", "c", "d", "e"];
  assert.deepEqual(rangeBetween(order, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(rangeBetween(order, "d", "b"), ["b", "c", "d"]);
  // An anchor filtered out of view: the range starts from the target alone.
  assert.deepEqual(rangeBetween(order, "zz", "c"), ["c"]);
});

test("move targets exclude every folder being moved", () => {
  const blocked = blockedMoveTargets([entry({ name: "F", id: "f", isFolder: true }), entry({ name: "x.txt", id: "x" })]);
  assert.deepEqual([...blocked], ["f"]);
});

test("middle truncation keeps the extension", () => {
  assert.equal(middleTruncate("short.txt", 22), "short.txt");
  const out = middleTruncate("Rapprochement bancaire de mars.csv", 22);
  assert.ok(out.endsWith("….csv"));
  assert.ok(out.length <= 22);
});
