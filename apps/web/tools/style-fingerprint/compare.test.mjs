import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compare } from "./compare.mjs";

/** A fingerprint directory holding one state file with the given elements. */
async function fingerprint(elements) {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-"));
  await mkdir(path.join(dir, "sky", "1440"), { recursive: true });
  await writeFile(path.join(dir, "sky", "1440", "channel.json"), JSON.stringify(elements));
  return dir;
}

const row = { path: "div.wc-msg", props: { "box-shadow": "none", color: "rgb(0, 0, 0)" } };

test("two identical fingerprints have no difference", async () => {
  assert.deepEqual(compare(await fingerprint([row]), await fingerprint([row])), []);
});

test("a changed property is reported once, with both values", async () => {
  const changed = { ...row, props: { ...row.props, "box-shadow": "rgb(0, 0, 0) 4px 4px 0px 0px" } };
  assert.deepEqual(compare(await fingerprint([row]), await fingerprint([changed])), [
    { file: path.join("sky", "1440", "channel.json"), path: "div.wc-msg", prop: "box-shadow", a: "none", b: "rgb(0, 0, 0) 4px 4px 0px 0px" },
  ]);
});

test("an element missing on one side is reported as missing", async () => {
  const diffs = compare(await fingerprint([row]), await fingerprint([]));
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].prop, "(missing)");
  assert.equal(diffs[0].path, "div.wc-msg");
});

test("a state file present on one side only is reported", async () => {
  const a = await fingerprint([row]);
  const b = await mkdtemp(path.join(tmpdir(), "fp-"));
  const diffs = compare(a, b);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].prop, "(missing file)");
});

test("live elements are left out: a presence dot and the dev server's overlay", async () => {
  const live = [
    row,
    { path: "div:2 > span.wc-av-wrap:0 > span.wc-av__dot:1", props: { "background-color": "rgb(207, 211, 218)" } },
    { path: "script:6 > nextjs-portal:0", props: { color: "rgb(0, 0, 0)" } },
    { path: "next-route-announcer:7", props: { color: "rgb(0, 0, 0)" } },
  ];
  const changed = [row, { path: "div:2 > span.wc-av-wrap:0 > span.wc-av__dot:1", props: { "background-color": "rgb(26, 158, 120)" } }];
  assert.deepEqual(compare(await fingerprint(live), await fingerprint(changed)), []);
});
