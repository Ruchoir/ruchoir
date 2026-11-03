import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error: a plain ES module of the design system's tests, without type declarations
import { blockDeclarations, readTokens } from "../../../packages/design-system/test/styleTokens.mjs";

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
