import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error: a plain ES module of the design system's tests, without type declarations
import { blockDeclarations, readTokens, STYLE_TOKENS } from "../../../packages/design-system/test/styleTokens.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "..");
const ds = path.resolve(web, "../../packages/design-system");

/** Every file under `dir` whose name ends with one of `exts`. */
function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** The families of tokens a style overrides: reading one that is not declared draws nothing. */
const FAMILIES = /^--(shadow|lift|press|edge|label-font|avatar-radius|sidebar|rail|msg|radius-(control|item|space|msg)|badge|tilt)\b/;

test("the web app reads no style token that the design system does not declare", () => {
  const declared = blockDeclarations(readFileSync(path.join(ds, "styles/tokens.css"), "utf8"), ":root") as Record<string, string>;
  const sources = [
    path.join(web, "app/components.css"),
    ...files(path.join(web, "features"), [".tsx", ".ts"]),
    ...files(path.join(ds, "src"), [".tsx"]),
    path.join(ds, "styles/components.css"),
  ];
  const missing: string[] = [];
  for (const file of sources) {
    for (const name of readTokens(readFileSync(file, "utf8")) as Set<string>) {
      if (FAMILIES.test(name) && !(name in declared)) missing.push(`${path.relative(web, file)}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("a pastel band restates every style token built on a value it redefines", () => {
  // A token holding var() is resolved on <html>: inside `.wc-pastel`, which redefines the ink and the
  // primary action, a token built on them would keep the root's (night) value.
  const pastel = blockDeclarations(readFileSync(path.join(web, "app/components.css"), "utf8"), ".wc-pastel") as Record<string, string>;
  const missing: string[] = [];
  for (const [token, value] of Object.entries(STYLE_TOKENS as Record<string, string>)) {
    const uses = [...value.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]).filter((n) => n in pastel);
    if (uses.length && !(token in pastel)) missing.push(`${token} (built on ${uses.join(", ")})`);
  }
  assert.deepEqual(missing, []);
});
