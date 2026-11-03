import assert from "node:assert/strict";
import { test } from "node:test";
import { themeBootstrap } from "./themeBootstrap.ts";

/** Run the pre-paint script on a fake browser and return what it stamped on <html>. */
function paint(stored: string | null, dark = false): Record<string, string> {
  const dataset: Record<string, string> = {};
  const localStorage = { getItem: (k: string) => (k === "ruchoir.settings" ? stored : null) };
  const document = { documentElement: { dataset } };
  const matchMedia = () => ({ matches: dark });
  new Function("localStorage", "document", "matchMedia", themeBootstrap)(localStorage, document, matchMedia);
  return dataset;
}

test("a style is stamped beside the accent, which stays", () => {
  assert.deepEqual(paint(JSON.stringify({ accent: "mint", style: "nuage" })), { theme: "mint", style: "nuage" });
});

test("a stored style that is not one is not stamped", () => {
  assert.deepEqual(paint(JSON.stringify({ style: "bogus" })), {});
  assert.deepEqual(paint(JSON.stringify({ style: ["nuage"] })), {});
  assert.deepEqual(paint(JSON.stringify({ style: 42, accent: "pink" })), { theme: "pink" });
});

test("automatic mode on a dark device: the night theme and the style", () => {
  assert.deepEqual(paint(JSON.stringify({ accent: "sky", mode: "auto", style: "indigo" }), true), { theme: "sky-dark", style: "indigo" });
});

test("nothing stored, or storage that cannot be read: nothing stamped, nothing thrown", () => {
  assert.deepEqual(paint(null), {});
  assert.deepEqual(paint("{not json"), {});
});

test("the other settings are still stamped", () => {
  assert.deepEqual(paint(JSON.stringify({ font: "dyslexic", textSize: "l", style: "marine" })), { font: "dyslexic", text: "l", style: "marine" });
});
