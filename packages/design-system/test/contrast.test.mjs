import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { contrast, resolveTokens, VARIANTS } from "./resolve.mjs";

const css = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");

/** [foreground, background, base the background is laid over (if translucent), minimum ratio]. */
const CONTENT = [
  ["--text-body", "--bg"], ["--text-muted", "--bg"], ["--text-strong", "--bg"], ["--text-link", "--bg"],
  ["--text-body", "--surface"], ["--text-muted", "--surface"], ["--text-strong", "--surface"], ["--text-link", "--surface"],
  ["--text-body", "--surface-mention", "--bg"],
  ["--action-primary-fg", "--action-primary-bg"],
  ["--badge-fg", "--badge-bg"],
  ["--on-pastel", "--acc"],
  ["--edge-focus", "--bg", null, 3],
  ["--control-line", "--bg", null, 3],
];
const SIDEBAR = [
  ["--text-body", "--sidebar-bg"], ["--text-strong", "--sidebar-bg"], ["--text-muted", "--sidebar-bg"],
  ["--sidebar-selected-fg", "--sidebar-selected-bg", "--sidebar-bg"],
  ["--badge-fg", "--badge-bg"],
  // An icon button drawn in the pane (the space's actions, the new message pen).
  ["--action-ghost-fg", "--sidebar-bg", null, 3],
  // A muted channel's count (a neutral badge on the line colour) and a tag (on the card surface).
  ["--text-body", "--line", "--sidebar-bg"],
  ["--text-body", "--surface-card", "--sidebar-bg"],
  // The keyboard focus of a row.
  ["--edge-focus", "--sidebar-bg", null, 3],
];
/** The rail holds icons and the instance's headings: what it draws must hold on it too. */
const RAIL = [
  ["--text-muted", "--rail-bg"],
  ["--action-ghost-fg", "--rail-bg", null, 3],
  ["--edge-focus", "--rail-bg", null, 3],
];

function check(tokens, pairs, where) {
  const failures = [];
  for (const [fg, bg, base = null, min = 4.5] of pairs) {
    const r = contrast(tokens, fg, bg, base);
    if (typeof r === "string") failures.push(`${where}: ${fg} on ${bg}: ${r}`);
    else if (r < min) failures.push(`${where}: ${fg} on ${bg}: ${r.toFixed(2)}:1, under ${min}:1`);
  }
  return failures;
}

test("every text of every style clears WCAG AA, by day and by night", () => {
  const failures = [];
  for (const v of VARIANTS) {
    for (const night of [false, true]) {
      const where = `${v} ${night ? "night" : "day"}`;
      failures.push(...check(resolveTokens(css, v, night), CONTENT, where));
      failures.push(...check(resolveTokens(css, v, night, "sidebar"), SIDEBAR, `${where} sidebar`));
      failures.push(...check(resolveTokens(css, v, night, "rail"), RAIL, `${where} rail`));
    }
  }
  assert.deepEqual(failures, []);
});

test("a colour that cannot be measured is named, not passed", () => {
  const r = contrast({ "--a": "color-mix(in srgb, red 50%, blue)", "--b": "#ffffff" }, "--a", "--b", null);
  assert.equal(typeof r, "string");
  assert.match(r, /--a/);
});
