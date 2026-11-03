import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { colourSelector, FLAT, paneSelector, RESTORE, shapeSelector, VARIANTS } from "./resolve.mjs";
import { blockDeclarations, STYLE_TOKENS } from "./styleTokens.mjs";

const css = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");

/** What a variant's shape block sets: the radius scale, the shapes, the density. */
const SHAPE = [
  "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl",
  "--radius-control", "--radius-item", "--radius-space", "--avatar-radius",
  "--msg-gap", "--msg-pad-x", "--msg-pad-top", "--msg-pad-top-grouped", "--msg-space",
  "--sidebar-selected-mark",
];

/** What a variant's colour blocks set, by day and by night alike. */
const COLOURS = [
  "--bg", "--surface", "--surface-chrome", "--line", "--line-strong", "--ink", "--body", "--muted",
  "--text-link", "--surface-mention", "--action-primary-bg", "--action-primary-bg-hover",
  "--action-primary-bg-active", "--action-primary-fg", "--edge-focus", "--sidebar-bg",
  "--sidebar-selected-bg", "--sidebar-selected-fg", "--rail-bg", "--badge-bg", "--badge-fg", "--msg-bg",
  "--msg-edge", "--acc", "--control-line",
];

/** The panes each variant colours (a light pane needs no text of its own). */
const PANES = { aubergine: ["sidebar", "rail"], nuage: ["rail"], indigo: [], marine: ["sidebar", "rail"] };

const names = (block) => Object.keys(block).sort();

test("every variant sets its radii, shapes and density", () => {
  for (const v of VARIANTS) {
    const shape = blockDeclarations(css, shapeSelector(v));
    for (const name of SHAPE) assert.ok(name in shape, `${v}: ${name} missing from ${shapeSelector(v)}`);
  }
});

test("a variant's day and night colours set the same names, so no day colour reaches the night", () => {
  for (const v of VARIANTS) {
    const day = blockDeclarations(css, colourSelector(v, false));
    const night = blockDeclarations(css, colourSelector(v, true));
    for (const name of COLOURS) assert.ok(name in day, `${v} by day: ${name} missing`);
    assert.deepEqual(names(night), names(day), `${v}: day and night colours differ in names`);
  }
});

test("a coloured pane is coloured by day and by night, with the same names", () => {
  for (const v of VARIANTS) {
    for (const pane of ["sidebar", "rail"]) {
      const day = blockDeclarations(css, paneSelector(v, false, pane));
      const night = blockDeclarations(css, paneSelector(v, true, pane));
      const coloured = PANES[v].includes(pane);
      assert.equal(names(day).length > 0, coloured, `${v} ${pane} by day`);
      assert.deepEqual(names(night), names(day), `${v} ${pane}: day and night differ in names`);
    }
  }
});

test("what floats inside a pane gets back every value a pane changes", () => {
  const flat = blockDeclarations(css, FLAT);
  const restore = blockDeclarations(css, RESTORE);
  for (const v of VARIANTS) {
    for (const pane of PANES[v]) {
      for (const name of names(blockDeclarations(css, paneSelector(v, false, pane)))) {
        const twin = `--float-${name.slice(2)}`;
        assert.equal(flat[twin], `var(${name})`, `${twin} not saved in the flat layer`);
        assert.equal(restore[name], `var(${twin})`, `${name} not restored inside a pane`);
      }
    }
  }
});

test("the styles come after the accents and the night, so a variant's values win", () => {
  const first = css.indexOf("[data-style");
  assert.ok(first > css.indexOf('[data-theme^="pink"] {'), "before the accents");
  assert.ok(first > css.indexOf('[data-theme$="-dark"] {'), "before the night");
});

test("the flat layer turns off every offset shadow, lift and tilt, and keeps a ring without offset", () => {
  const flat = blockDeclarations(css, FLAT);
  const off = [
    ...Object.keys(STYLE_TOKENS).filter((n) => /^--(shadow|lift|press|tilt)/.test(n) && !n.startsWith("--shadow-ring-offset")),
    "--shadow-offset-sm", "--shadow-popover", "--shadow-dialog", "--shadow-lift",
  ];
  for (const name of off) assert.equal(flat[name], "none", `${name} is not turned off`);
  assert.equal(flat["--shadow-ring-offset"], "0 0 0 2px var(--edge-focus)");
  assert.equal(flat["--shadow-ring-offset-sm"], "0 0 0 1.5px var(--edge-focus)");
});
