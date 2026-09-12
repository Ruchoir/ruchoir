#!/usr/bin/env node
/**
 * Two questions, answered on every run and in CI:
 *
 * 1. **Is any user-visible text still hard-coded?** A string typed into a component is invisible to
 *    translation: it ships in French to a Polish reader and nothing reports it. Adding one is easy,
 *    noticing one is not, which is exactly the kind of drift a check belongs on.
 * 2. **Do the six dictionaries agree?** TypeScript already refuses a locale missing a key, but it
 *    cannot see a key nobody uses, or a French string left untranslated in another locale.
 *
 * It reads the source rather than the build: the point is to fail the change that introduces the
 * problem, next to the line that introduces it.
 *
 * Usage: `pnpm --filter @ruchoir/web i18n:check` (CI runs the same command).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components", "features"];
const DICT_DIR = join(WEB_ROOT, "lib/i18n/dictionaries");

/** Attributes whose value reaches a person's eyes or a screen reader. */
const TEXT_ATTRS = [
  "label",
  "aria-label",
  "placeholder",
  "title",
  "subtitle",
  "description",
  "hint",
  "alt",
  "confirmLabel",
  "cancelLabel",
  "emptyLabel",
];

/**
 * Strings that are not prose, listed once rather than guessed at by pattern.
 *
 * Every entry is a decision: a CSS value, a machine identifier, a brand name. The list is short on
 * purpose. If it starts growing, the rule is wrong, not the code.
 */
const ALLOWED = new Set([
  "Ruchoir",
  "IBM Plex Sans",
  "IBM Plex Mono",
  "OpenDyslexic",
  "Comic Sans MS",
  "Helvetica Neue",
  "Segoe UI",
]);

/** A file is skipped entirely when it carries this marker, with the reason on the same line. */
const FILE_OPT_OUT = "i18n-audit-ignore-file";
/** A single line is skipped when the line before it carries this marker. */
const LINE_OPT_OUT = "i18n-audit-ignore-next-line";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(path, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Whether a string looks like prose rather than an identifier, a class list or a CSS value. */
function looksLikeProse(value) {
  const text = value.trim();
  if (text.length < 3) return false;
  if (ALLOWED.has(text)) return false;
  // Needs at least one run of three letters: `px`, `1fr`, `#fff`, `sm` and friends are not prose.
  if (!/[A-Za-zÀ-ÿ]{3}/.test(text)) return false;
  // CSS values, custom properties, selectors, URLs, paths, mime types, format strings.
  if (/^(var\(|--|#|\.|\/|https?:|data:|blob:|[a-z-]+\/[a-z-]+$)/.test(text)) return false;
  if (/^[\d.]+(px|rem|em|%|vh|vw|s|ms|fr)$/.test(text)) return false;
  // A single lower-case word with no space is an identifier (an icon name, a key, a variant).
  if (!/\s/.test(text) && !/[A-ZÀ-Ý]/.test(text) && !/['’]/.test(text)) return false;
  // camelCase and kebab-case identifiers, even with capitals.
  if (/^[a-z]+([A-Z][a-z]*)+$/.test(text)) return false;
  if (/^[a-z]+(-[a-z]+)+$/.test(text)) return false;
  // A TypeScript type in a signature: `Promise<MessageAttachment>` reads as text between two tags.
  if (/^(Promise|Record|Array|Map|Set|Partial|Omit|Pick|Readonly)$/.test(text)) return false;
  // A dictionary key, not a sentence: `mfa.totpTitle`. Tables built at module load hold keys and
  // are translated where they are drawn, which is the shape this check wants to encourage.
  if (/^[a-z][\w]*(\.[A-Za-z]\w*)+$/.test(text)) return false;
  // Code caught between a `>` and a `<`: `x > 0 && x < 10` reads as text between two tags to a
  // scanner that does not parse. Operators never appear in prose the product shows.
  if (/(&&|\|\||===?|!==?|=>|\+\+|;\s*$)/.test(text)) return false;
  return true;
}

/** Hard-coded strings in one file, as `{ line, text }`. */
function findHardCoded(source, path) {
  if (source.includes(FILE_OPT_OUT)) return [];
  const isJsx = path.endsWith(".tsx");
  const lines = source.split("\n");
  const found = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (i > 0 && lines[i - 1].includes(LINE_OPT_OUT)) continue;
    // Imports and type-only lines carry no prose.
    if (/^\s*(import|export type|export \{)/.test(line)) continue;
    // Comments are written for whoever reads the code, in English like the rest of the repository,
    // and are never rendered. A doc comment quoting an element name looked like text between tags.
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
    // A line that is already translating is not a finding, whatever quotes it contains.
    const stripped = line.replace(/\bt\(\s*["'][^"']+["']/g, "");

    // 1. Text between JSX tags: `>Bonjour<`, and the start of a multi-line run. Only in `.tsx`:
    // in plain TypeScript the same shape is a comparison (`x >= from && now <= to`).
    if (isJsx) {
      for (const match of stripped.matchAll(/>\s*([^<>{}\n][^<>{}\n]*)</g)) {
        if (looksLikeProse(match[1])) found.push({ line: i + 1, text: match[1].trim() });
      }
    }
    // 2. Translatable attributes with a literal value.
    for (const attr of TEXT_ATTRS) {
      const re = new RegExp(`\\b${attr}\\s*=\\s*(?:\\{\\s*)?["']([^"']+)["']`, "g");
      for (const match of stripped.matchAll(re)) {
        if (looksLikeProse(match[1])) found.push({ line: i + 1, text: match[1].trim() });
      }
      // Object form: `{ label: "Inviter des personnes" }`.
      const objRe = new RegExp(`\\b${attr}\\s*:\\s*["']([^"']+)["']`, "g");
      for (const match of stripped.matchAll(objRe)) {
        if (looksLikeProse(match[1])) found.push({ line: i + 1, text: match[1].trim() });
      }
    }
    // 3. Any literal holding an accented character: French prose the other two rules missed.
    for (const match of stripped.matchAll(/["']([^"'\n]*[À-ÿ][^"'\n]*)["']/g)) {
      if (looksLikeProse(match[1])) found.push({ line: i + 1, text: match[1].trim() });
    }
  }

  // One report per line, however many rules fired on it.
  const seen = new Set();
  return found.filter((f) => {
    const key = `${f.line}:${f.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((f) => ({ ...f, file: relative(WEB_ROOT, path) }));
}

/**
 * Keys that deliberately hold the same French text as another key.
 *
 * The rule is that one sentence gets one key: duplicating it costs bytes in six files and, worse,
 * lets two copies of the same sentence drift apart until the interface says it two ways. The
 * exception exists because French collapses distinctions other languages keep (a label and a verb,
 * a role and a status), so a pair that is identical here may have to differ in German or Polish.
 * Each entry is that claim, made once, in writing.
 */
const ALLOWED_DUPLICATES = new Set([
  // "Enregistrer" is two different verbs in French: saving a form, and setting a message aside for
  // later. English happens to collapse them too, but German ("Speichern" / "Merken") and Polish do
  // not, so merging the keys would force one language to say the wrong thing.
  "message.save",
]);

/** Every key path in a dictionary object, flattened to `a.b.c`. */
function keyPaths(value, prefix = "", out = []) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) keyPaths(child, path, out);
    else out.push(path);
  }
  return out;
}

async function loadDictionaries() {
  const locales = readdirSync(DICT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
  const dicts = {};
  for (const locale of locales) {
    dicts[locale] = JSON.parse(readFileSync(join(DICT_DIR, `${locale}.json`), "utf8"));
  }
  return dicts;
}

/** The value at a flattened key path. */
function valueAt(dict, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), dict);
}

/** Keys used in the source, as `t("some.key")`. Dynamic keys are invisible here, by construction. */
function usedKeys(files) {
  const used = new Set();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bt\(\s*["']([\w.]+)["']/g)) used.add(match[1]);
  }
  return used;
}

/**
 * Files not yet translated, and tolerated until they are.
 *
 * The interface was written in French throughout before any of this existed, so the choice was
 * between one unreviewable change touching every screen, and a list that shrinks. This is the list.
 * It buys nothing except time: a file on it is still untranslated, and the check fails the moment a
 * new hard-coded string appears anywhere else.
 *
 * Two rules keep it honest: nothing may be added to it (a new screen is written translated), and a
 * file that has become clean is reported so the line goes.
 */
const DEBT_FILE = join(WEB_ROOT, "tools/i18n-audit/untranslated.json");
const debt = new Set(JSON.parse(readFileSync(DEBT_FILE, "utf8")).files);

const files = SCAN_DIRS.flatMap((dir) => walk(join(WEB_ROOT, dir)));
const allFindings = files.flatMap((file) => findHardCoded(readFileSync(file, "utf8"), file));
const hardCoded = allFindings.filter((f) => !debt.has(f.file));
const stillOwed = new Set(allFindings.filter((f) => debt.has(f.file)).map((f) => f.file));
const settled = [...debt].filter((file) => !stillOwed.has(file));

const dicts = await loadDictionaries();
const source = dicts.fr ?? {};
const sourceKeys = keyPaths(source);
const problems = [];

for (const [locale, dict] of Object.entries(dicts)) {
  if (locale === "fr") continue;
  const keys = new Set(keyPaths(dict));
  for (const key of sourceKeys) {
    if (!keys.has(key)) problems.push(`${locale}: missing key ${key}`);
  }
  for (const key of keys) {
    if (!sourceKeys.includes(key)) problems.push(`${locale}: key ${key} exists in no source dictionary`);
  }
}

// One sentence, one key. Checked on the source dictionary, since the others follow its shape.
const byText = new Map();
for (const key of sourceKeys) {
  const text = valueAt(source, key);
  if (typeof text !== "string" || ALLOWED_DUPLICATES.has(key)) continue;
  const normalized = text.trim();
  if (!byText.has(normalized)) byText.set(normalized, []);
  byText.get(normalized).push(key);
}
const duplicates = [...byText.entries()].filter(([, keys]) => keys.length > 1);

const used = usedKeys(files);
const unused = sourceKeys.filter((key) => !used.has(key));

let failed = false;

if (hardCoded.length > 0) {
  failed = true;
  console.error(`\n${hardCoded.length} hard-coded string(s): they ship in French to every reader.\n`);
  for (const finding of hardCoded) {
    console.error(`  ${finding.file}:${finding.line}  ${JSON.stringify(finding.text)}`);
  }
  console.error(
    `\nMove each into lib/i18n/dictionaries and call t("..."). For something that is not prose,\n` +
      `add it to ALLOWED in this script, or mark the line with ${LINE_OPT_OUT} and say why.\n`,
  );
}

if (settled.length > 0) {
  failed = true;
  console.error(
    `\n${settled.length} file(s) listed as untranslated carry no hard-coded text any more.\n` +
      `Remove them from tools/i18n-audit/untranslated.json: the list only ever shrinks.\n`,
  );
  for (const file of settled) console.error(`  ${file}`);
  console.error("");
}

if (duplicates.length > 0) {
  failed = true;
  console.error(
    `\n${duplicates.length} text(s) held under more than one key. One sentence, one key: two copies\n` +
      `cost six files' worth of bytes and drift apart until the interface says it two ways.\n`,
  );
  for (const [text, keys] of duplicates) {
    console.error(`  ${JSON.stringify(text)}\n    ${keys.join("\n    ")}`);
  }
  console.error(
    `\nPoint every call site at one key. If two of them genuinely have to differ in another\n` +
      `language, list the key in ALLOWED_DUPLICATES in this script and say why.\n`,
  );
}

if (problems.length > 0) {
  failed = true;
  console.error(`\n${problems.length} dictionary problem(s):\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("");
}

// Unused keys are reported without failing: a key may legitimately be built dynamically, and a
// check that cannot tell the difference must not be the one that blocks a merge.
if (unused.length > 0) {
  console.warn(`\n${unused.length} key(s) not found in the source (dynamic use, or dead):\n`);
  for (const key of unused) console.warn(`  ${key}`);
  console.warn("");
}

if (failed) process.exit(1);
const owed = [...stillOwed].length;
console.log(
  `i18n: ${sourceKeys.length} keys across ${Object.keys(dicts).length} languages, ` +
    `no hard-coded text outside the ${owed} file(s) still listed as untranslated.`,
);
if (owed > 0) {
  console.log(`Remaining: ${[...stillOwed].sort().join(", ")}`);
}
