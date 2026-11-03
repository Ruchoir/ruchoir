#!/usr/bin/env node
/**
 * The office editor's theme for each simplified style, written from the design system's tokens so
 * the editor never drifts from the app: `theme-ruchoir-<style>-light.json` in `infra/office/themes`,
 * with the same colours as the hand-made Ruchoir theme, mapped from the style's day tokens. By night
 * the engine uses its own dark theme (upstream defect 3) with the style's tint laid over it by the
 * patched WOPI page, so there is no night file.
 *
 *   node tools/office-themes/build.mjs    (from apps/web; build.test.mjs fails until it is run)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveTokens, VARIANTS } from "../../../../packages/design-system/test/resolve.mjs";

const root = new URL("../../../../", import.meta.url);

/** The style's name in the engine's theme menu: French, and English for every other language. */
const NAMES = {
  aubergine: { fr: "Aubergine", en: "Aubergine" },
  nuage: { fr: "Nuage", en: "Cloud" },
  indigo: { fr: "Indigo", en: "Indigo" },
  marine: { fr: "Marine", en: "Navy" },
};

const EDITORS = ["document", "spreadsheet", "presentation", "pdf"];

/** Where a style's theme file lives. */
export function themePath(variant) {
  return new URL(`infra/office/themes/theme-ruchoir-${variant}-light.json`, root);
}

/** `#rrggbb` at an opacity, as the engine's own themes write it. */
function rgba(hex, alpha) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The engine theme of one style, from the tokens of `tokens.css` (its text, given as `css`). */
export function officeThemeFor(css, variant) {
  const t = resolveTokens(css, variant, false);
  const read = (name) => {
    const value = (t[name] ?? "").toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(value)) throw new Error(`${variant}: ${name} is not a plain colour (${value})`);
    return value;
  };
  const surface = read("--surface");
  const ink = read("--ink");
  const canvas = read("--bg");
  const primary = read("--action-primary-bg");
  const acc = read("--acc");
  const line = read("--line");
  const each = (prefix, value, editors = [...EDITORS, "visio"]) =>
    Object.fromEntries(editors.map((e) => [`${prefix}-${e}`, value]));
  const name = NAMES[variant];
  return {
    name: name.en,
    l10n: { fr: `${name.fr} jour`, en: `${name.en} day` },
    id: `theme-ruchoir-${variant}-light`,
    type: "light",
    colors: {
      ...each("toolbar-header", surface),
      "text-toolbar-header": ink,
      "icon-toolbar-header": ink,
      ...each("text-toolbar-header-on-background", surface),
      "highlight-header-button-hover": rgba(ink, 0.05),
      "highlight-header-button-pressed": rgba(ink, 0.09),
      ...each("highlight-header-tab-underline", primary),
      "background-normal": surface,
      "background-toolbar": canvas,
      "background-toolbar-tab": canvas,
      "background-toolbar-additional": canvas,
      "background-pane": surface,
      "background-pane-additional": canvas,
      "background-primary-dialog-button": primary,
      "highlight-primary-dialog-button-hover": read("--action-primary-bg-hover"),
      "highlight-primary-dialog-button-pressed": read("--action-primary-bg-active"),
      "background-accent-button": primary,
      "highlight-button-hover": rgba(ink, 0.05),
      "highlight-button-pressed": rgba(acc, 0.45),
      "highlight-button-pressed-hover": rgba(acc, 0.6),
      ...each("highlight-toolbar-tab-underline", primary),
      "highlight-text-select": acc,
      "border-toolbar": line,
      "border-divider": line,
      "border-regular-control": read("--line-strong"),
      "border-control-focus": read("--edge-focus"),
      "border-toolbar-active-tab": line,
      "text-normal": ink,
      "text-secondary": read("--muted"),
      "text-tertiary": read("--text-disabled"),
      "text-link": read("--text-link"),
      "canvas-background": canvas,
      "ruchoir-painted": "1",
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const css = readFileSync(new URL("packages/design-system/styles/tokens.css", root), "utf8");
  for (const v of VARIANTS) {
    writeFileSync(themePath(v), `${JSON.stringify(officeThemeFor(css, v), null, 1)}\n`);
    console.log(`wrote theme-ruchoir-${v}-light.json`);
  }
}
