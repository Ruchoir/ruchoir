#!/usr/bin/env node
/**
 * Compare two style fingerprints written by `run.mjs` (see README.md).
 *
 *   node tools/style-fingerprint/compare.mjs <before-dir> <after-dir>
 *
 * Prints every element property that differs, and exits 1 when anything does, 0 otherwise.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{ path: string, props: Record<string, string> }} Element */
/** @typedef {{ file: string, path: string, prop: string, a: string, b: string }} Diff */

/** Every `.json` file under `dir`, relative to it. */
function jsonFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(path.join(dir, rel))) {
      const r = path.join(rel, name);
      if (statSync(path.join(dir, r)).isDirectory()) walk(r);
      else if (name.endsWith(".json")) out.push(r);
    }
  };
  walk("");
  return out;
}

/** The elements of a state file, keyed by path (a repeated path gets `#n` from its second time). */
function byPath(file) {
  /** @type {Element[]} */
  const elements = JSON.parse(readFileSync(file, "utf8"));
  const map = new Map();
  for (const el of elements) {
    let key = el.path;
    for (let n = 2; map.has(key); n++) key = `${el.path}#${n}`;
    map.set(key, el.props);
  }
  return map;
}

/**
 * The differences between fingerprint directories `a` and `b`.
 * @param {string} a
 * @param {string} b
 * @returns {Diff[]}
 */
export function compare(a, b) {
  /** @type {Diff[]} */
  const diffs = [];
  const filesA = jsonFiles(a);
  const filesB = new Set(jsonFiles(b));
  for (const file of filesA) {
    if (!filesB.has(file)) {
      diffs.push({ file, path: "", prop: "(missing file)", a: "present", b: "absent" });
      continue;
    }
    filesB.delete(file);
    const ea = byPath(path.join(a, file));
    const eb = byPath(path.join(b, file));
    for (const [key, pa] of ea) {
      const pb = eb.get(key);
      if (!pb) {
        diffs.push({ file, path: key, prop: "(missing)", a: "present", b: "absent" });
        continue;
      }
      for (const prop of Object.keys(pa)) {
        if (pa[prop] !== pb[prop]) diffs.push({ file, path: key, prop, a: pa[prop], b: pb[prop] });
      }
    }
    for (const key of eb.keys()) {
      if (!ea.has(key)) diffs.push({ file, path: key, prop: "(missing)", a: "absent", b: "present" });
    }
  }
  for (const file of filesB) diffs.push({ file, path: "", prop: "(missing file)", a: "absent", b: "present" });
  return diffs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error("usage: compare.mjs <before-dir> <after-dir>");
    process.exit(2);
  }
  const diffs = compare(a, b);
  for (const d of diffs) console.log(`${d.file}  ${d.path}  ${d.prop}: ${d.a}  ->  ${d.b}`);
  console.log(diffs.length === 0 ? "No difference." : `${diffs.length} difference(s).`);
  process.exit(diffs.length === 0 ? 0 : 1);
}
