import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { resolveTokens, VARIANTS } from "../../../../packages/design-system/test/resolve.mjs";
import { officeThemeFor, themePath } from "./build.mjs";

const root = new URL("../../../../", import.meta.url);
const css = readFileSync(new URL("packages/design-system/styles/tokens.css", root), "utf8");
const ruchoir = JSON.parse(readFileSync(new URL("infra/office/themes/theme-ruchoir-light.json", root), "utf8"));

test("each style's engine theme is the one the tokens give: regenerate it after a colour change", () => {
  for (const v of VARIANTS) {
    const committed = JSON.parse(readFileSync(themePath(v), "utf8"));
    assert.deepEqual(committed, officeThemeFor(css, v), `${v}: run node tools/office-themes/build.mjs`);
  }
});

test("a style's engine theme sets every colour the Ruchoir one does, and only those", () => {
  for (const v of VARIANTS) {
    const theme = officeThemeFor(css, v);
    assert.deepEqual(Object.keys(theme.colors).sort(), Object.keys(ruchoir.colors).sort(), v);
    assert.equal(theme.id, `theme-ruchoir-${v}-light`);
    assert.equal(theme.type, "light");
    assert.equal(theme.colors["ruchoir-painted"], "1");
    for (const [k, c] of Object.entries(theme.colors)) {
      if (k === "ruchoir-painted") continue;
      assert.match(c, /^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/, `${v} ${k}: ${c}`);
    }
  }
});

test("the API lays each style's tint over the editor, as the tokens declare it", () => {
  const sessions = readFileSync(new URL("apps/api/src/office/sessions.rs", root), "utf8");
  for (const v of VARIANTS) {
    const tint = resolveTokens(css, v, false)["--acc"];
    const line = sessions.split("\n").find((l) => l.includes(`Some("${v}")`) && /=> "#[0-9a-f]{6}"/.test(l));
    assert.ok(line?.includes(`"${tint}"`), `${v}: sessions.rs should map it to ${tint}, has ${line?.trim()}`);
  }
});
