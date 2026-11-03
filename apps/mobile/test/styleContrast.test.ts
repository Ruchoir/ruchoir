// The four simplified styles on the phone keep every text readable (WCAG AA): 4.5:1 for text, 3:1
// for the edges a control or the focus is found by. Read from `tokens.ts`, so the phone's copy is
// checked on its own, as the web's is in the design system.
import { test } from "node:test";
import assert from "node:assert/strict";

import { contrast } from "../../../packages/design-system/test/resolve.mjs";
import { palette, semantic, VARIANTS } from "../src/theme/tokens.ts";

const TEXT: [string, string][] = [
  ["body", "bg"],
  ["body", "surface"],
  ["muted", "bg"],
  ["muted", "surface"],
  ["ink", "mention"],
  ["link", "bg"],
  ["onPrimary", "primary"],
  ["onBadge", "badge"],
  ["barFg", "bar"],
  ["barMuted", "bar"],
  ["onPastel", "acc"],
];
const EDGES: [string, string][] = [
  ["controlLine", "surface"],
  ["focus", "bg"],
];

test("every_style_keeps_its_text_readable_on_the_phone", () => {
  const failures: string[] = [];
  for (const v of VARIANTS) {
    for (const night of [false, true]) {
      const p = palette(v, "violet", night);
      const s = semantic(p, night, v);
      const all: Record<string, string> = Object.fromEntries(
        Object.entries({ ...p, ...s }).filter(([, value]) => typeof value === "string"),
      );
      const pairs: [string, string, number][] = [
        ...TEXT.map(([f, b]) => [f, b, 4.5] as [string, string, number]),
        ...EDGES.map(([f, b]) => [f, b, 3] as [string, string, number]),
      ];
      if (s.msgBg) pairs.push(["ink", "msgBg", 4.5], ["muted", "msgBg", 4.5]);
      for (const [fg, bg, min] of pairs) {
        const ratio = contrast(all, fg, bg);
        if (typeof ratio === "string") failures.push(`${v}${night ? " night" : ""} ${fg} on ${bg}: ${ratio}`);
        else if (ratio < min) failures.push(`${v}${night ? " night" : ""} ${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});
