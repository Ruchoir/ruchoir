// Every screen draws its corners, lines and shadows from the theme, so a flat style reaches it: no
// file outside `src/theme/` imports the Ruchoir radii or hairline, or writes an offset shadow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return path.endsWith("/theme") ? [] : files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const RUCHOIR_SHAPE = /import\s*\{[^}]*\b(radius|hairline)\b[^}]*\}\s*from\s*"[./]*\/?theme\/tokens"/;

test("no_screen_draws_the_ruchoir_shape_by_hand", () => {
  const offenders = files(SRC)
    .filter((path) => {
      const text = readFileSync(path, "utf8");
      return RUCHOIR_SHAPE.test(text) || /shadowOffset/.test(text);
    })
    .map((path) => relative(SRC, path));
  assert.deepEqual(offenders, []);
});
