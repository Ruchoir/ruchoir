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

test("no_file_names_the_tools_the_styles_recall", () => {
  const roots = ["../src/", "../targets/"].map((p) => new URL(p, import.meta.url).pathname);
  const offenders = roots
    .flatMap((root) => files(root).concat(root.endsWith("targets/") ? readdirSync(join(root, "widgets")).filter((n) => n.endsWith(".swift")).map((n) => join(root, "widgets", n)) : []))
    .filter((path) => /\b(Slack|Nextcloud|Mattermost|Microsoft Teams)\b/.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path));
  assert.deepEqual(offenders, []);
});
