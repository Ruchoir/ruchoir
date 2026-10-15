// Run with `pnpm --filter @ruchoir/mobile test` (Node's own runner, types stripped by Node).
// The app cannot read CSS, so its palette is a copy: this keeps the copy honest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ACCENTS, PALETTE_KEYS, themeName, tokens } from "../src/theme/tokens.ts";

const css = readFileSync(new URL("../../../packages/design-system/styles/tokens.css", import.meta.url), "utf8");

/** The custom properties declared directly in the block that opens with `selector {`. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no ${selector} block in tokens.css`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

/** `--line-strong` for `lineStrong`. */
const cssName = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function resolve(vars: Record<string, string>, key: string): string {
  let value = vars[cssName(key)];
  for (let i = 0; value?.startsWith("var(") && i < 5; i++) value = vars[value.slice(6, -1)];
  return value;
}

const root = block(":root");
const violet = { ...root, ...block('[data-theme^="violet"]') };
const violetDark = { ...violet, ...block('[data-theme$="-dark"]') };

test("light_palette_matches_tokens_css", () => {
  for (const key of PALETTE_KEYS) assert.equal(tokens.violet[key], resolve(violet, key), key);
});

test("dark_palette_matches_tokens_css", () => {
  for (const key of PALETTE_KEYS) assert.equal(tokens["violet-dark"][key], resolve(violetDark, key), key);
});

test("every_accent_by_day_and_by_night_matches_tokens_css", () => {
  for (const accent of ACCENTS) {
    // Sky is the bare :root; the other accents only swap `--acc`.
    const day = accent === "sky" ? root : { ...root, ...block(`[data-theme^="${accent}"]`) };
    const night = { ...day, ...block('[data-theme$="-dark"]') };
    for (const key of PALETTE_KEYS) {
      assert.equal(tokens[themeName(accent, false)][key], resolve(day, key), `${accent} ${key}`);
      assert.equal(tokens[themeName(accent, true)][key], resolve(night, key), `${accent}-dark ${key}`);
    }
  }
});
