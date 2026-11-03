import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { STYLE_TOKENS, blockDeclarations, readTokens } from "./styleTokens.mjs";

const styles = new URL("../styles/", import.meta.url);
const tokensCss = readFileSync(new URL("tokens.css", styles), "utf8");
const componentsCss = readFileSync(new URL("components.css", styles), "utf8");

test("every style token is declared on the bare :root with its Ruchoir value", () => {
  const root = blockDeclarations(tokensCss, ":root");
  for (const [name, value] of Object.entries(STYLE_TOKENS)) {
    assert.equal(root[name], value, `${name} on :root`);
  }
});

test("the components read no style token that tokens.css does not declare", () => {
  const root = blockDeclarations(tokensCss, ":root");
  for (const name of readTokens(componentsCss)) {
    if (name in STYLE_TOKENS) assert.ok(name in root, `${name} is read by components.css`);
  }
});
