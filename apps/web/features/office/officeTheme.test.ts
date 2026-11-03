import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { officeAccent, officeStyle, officeTheme } from "./officeTheme.ts";

/** A document whose <html> carries these attributes, for the duration of one test. */
function html(attrs: Record<string, string>) {
  (globalThis as { document?: unknown }).document = {
    documentElement: { getAttribute: (name: string) => attrs[name] ?? null },
  };
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

test("the editor is told the style on screen", () => {
  html({ "data-theme": "sky", "data-style": "marine" });
  assert.equal(officeStyle(), "marine");
});

test("no style on screen, or no screen at all: nothing is sent", () => {
  html({ "data-theme": "sky" });
  assert.equal(officeStyle(), undefined);
  delete (globalThis as { document?: unknown }).document;
  assert.equal(officeStyle(), undefined);
});

test("the accent and the night are still read beside a style", () => {
  html({ "data-theme": "mint-dark", "data-style": "nuage" });
  assert.equal(officeAccent(), "mint");
  assert.equal(officeTheme(), "dark");
});
