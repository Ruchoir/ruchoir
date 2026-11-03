import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_STYLES, storedStyle, styleAttr } from "./appearance.ts";

test("the five styles, Ruchoir first", () => {
  assert.deepEqual(APP_STYLES, ["ruchoir", "aubergine", "nuage", "indigo", "marine"]);
});

test("a stored style is read back as itself", () => {
  for (const style of APP_STYLES) assert.equal(storedStyle(style), style);
});

test("a stored value that is not a style falls back to Ruchoir", () => {
  for (const value of ["bogus", 42, undefined, null, "", "Nuage", ["nuage"]]) assert.equal(storedStyle(value), "ruchoir");
});

test("Ruchoir carries no attribute, a simplified style its name", () => {
  assert.equal(styleAttr("ruchoir"), undefined);
  assert.equal(styleAttr("marine"), "marine");
});
