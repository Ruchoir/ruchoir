// Builds the emoji search keywords for the five languages other than French, from the Unicode CLDR
// annotations as published in the emojibase-data package (MIT; the data itself is Unicode's, under
// the Unicode licence). Run once and the result is committed: nothing is fetched at build or at run
// time, and the package is not a dependency of Ruchoir.
//
// Only the emoji the picker actually offers are kept (read from lib/emoji.ts), each with its CLDR
// name and tags, so a language costs a few tens of kilobytes rather than the whole dataset.
//
// Usage:
//   npm pack emojibase-data@17.0.0 && tar xzf emojibase-data-17.0.0.tgz     # in a scratch directory
//   node scripts/build-emoji-keywords.mjs --data /path/to/package
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import emojiRegex from "emoji-regex";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dataIdx = args.indexOf("--data");
if (dataIdx === -1 || !args[dataIdx + 1]) {
  console.error("usage: node scripts/build-emoji-keywords.mjs --data <emojibase-data directory>");
  process.exit(1);
}
const dataDir = args[dataIdx + 1];
const outDir = join(here, "..", "lib", "emoji-keywords");
const LOCALES = ["en", "es", "de", "it", "pl"];

// The picker's emoji: every emoji written in lib/emoji.ts.
const source = readFileSync(join(here, "..", "lib", "emoji.ts"), "utf8");
const wanted = [...new Set(source.match(emojiRegex()) ?? [])];

// A glyph with or without its variation selector is the same emoji for lookup purposes.
const bare = (e) => e.replace(/️/g, "");

mkdirSync(outDir, { recursive: true });
for (const locale of LOCALES) {
  const data = JSON.parse(readFileSync(join(dataDir, locale, "data.json"), "utf8"));
  const byGlyph = new Map();
  for (const entry of data) {
    byGlyph.set(bare(entry.emoji), entry);
    for (const skin of entry.skins ?? []) byGlyph.set(bare(skin.emoji), skin);
  }
  const out = {};
  const missing = [];
  for (const glyph of wanted) {
    const entry = byGlyph.get(bare(glyph));
    if (!entry) {
      missing.push(glyph);
      continue;
    }
    const words = [entry.label, ...(entry.tags ?? [])].map((w) => w.toLowerCase());
    out[glyph] = [...new Set(words)].join(" ");
  }
  writeFileSync(join(outDir, `${locale}.json`), JSON.stringify(out, null, 1) + "\n");
  console.log(`${locale}: ${Object.keys(out).length}/${wanted.length}${missing.length ? ` (no CLDR entry: ${missing.join(" ")})` : ""}`);
}
