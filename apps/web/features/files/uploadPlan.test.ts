// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { folderPaths, splitPath, tooLarge } from "./uploadPlan.ts";

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
