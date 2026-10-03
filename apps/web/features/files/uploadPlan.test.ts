// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { folderPaths, isTaken, splitPath, tooLarge, uniqueName } from "./uploadPlan.ts";

test("a taken name gets the first free number before its extension", () => {
  assert.equal(uniqueName("Facture.pdf", ["Facture.pdf"]), "Facture (1).pdf");
  assert.equal(uniqueName("Facture.pdf", ["Facture.pdf", "Facture (1).pdf"]), "Facture (2).pdf");
  assert.equal(uniqueName("Facture.pdf", ["Budget.xlsx"]), "Facture.pdf");
  assert.equal(uniqueName("Notes", ["Notes"]), "Notes (1)");
  assert.equal(uniqueName("archive.tar.gz", ["archive.tar.gz"]), "archive.tar (1).gz");
  assert.equal(uniqueName(".env", [".env"]), ".env (1)");
});

test("names are compared without case, as the people sending them do", () => {
  assert.equal(isTaken("facture.PDF", ["Facture.pdf"]), true);
  assert.equal(uniqueName("facture.pdf", ["Facture.pdf"]), "facture (1).pdf");
});

test("a size over the cap is too large, and no cap means no limit", () => {
  assert.equal(tooLarge(101, 100), true);
  assert.equal(tooLarge(100, 100), false);
  assert.equal(tooLarge(10 ** 12, undefined), false);
});

test("a relative path splits into its folders and its name", () => {
  assert.deepEqual(splitPath("Photos/2026/mars/a.jpg"), { dirs: ["Photos", "2026", "mars"], name: "a.jpg" });
  assert.deepEqual(splitPath("a.jpg"), { dirs: [], name: "a.jpg" });
  assert.deepEqual(splitPath("/Photos//a.jpg"), { dirs: ["Photos"], name: "a.jpg" });
});

test("the folders a set of paths needs, each once, parents first", () => {
  assert.deepEqual(folderPaths(["Photos/2026/a.jpg", "Photos/2026/b.jpg", "Photos/c.jpg", "Docs/x.pdf", "loose.txt"]), [
    "Photos",
    "Photos/2026",
    "Docs",
  ]);
  assert.deepEqual(folderPaths(["a.txt"]), []);
});
