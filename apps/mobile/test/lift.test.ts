import { test } from "node:test";
import assert from "node:assert/strict";

import { lift, soft } from "../src/theme/lift.ts";
import { palette, semantic, SHAPES, type Style } from "../src/theme/tokens.ts";

const theme = (style: Style, dark = false) => {
  const c = palette(style, "violet", dark);
  return { c, s: semantic(c, dark, style), dark, style, shape: SHAPES[style] };
};

test("a_flat_style_drops_the_offset", () => {
  for (const style of ["aubergine", "nuage", "indigo", "marine"] as const) assert.deepEqual(lift(theme(style), 4, 4), {}, style);
});

test("the_ruchoir_style_keeps_its_hard_offset", () => {
  const t = theme("ruchoir");
  assert.deepEqual(lift(t, 4, 4, t.c.bee), {
    shadowColor: t.c.bee,
    shadowOffset: { width: 4, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 4,
  });
  assert.equal(lift(t, 3, 3).shadowColor, t.s.shadow);
  assert.deepEqual(lift(t, 0, 6).shadowOffset, { width: 0, height: 6 });
});

test("a_soft_shadow_is_dropped_by_a_flat_style_too", () => {
  assert.deepEqual(soft(theme("marine"), 3, 0.18, 8), {});
  const t = theme("ruchoir", true);
  assert.deepEqual(soft(t, 3, 0.18, 8), { shadowColor: "#000000", shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 4 });
});

test("a_lift_can_keep_the_elevation_it_had", () => {
  const t = theme("ruchoir");
  assert.equal(lift(t, 2, 2, t.c.acc, 4).elevation, 4);
  assert.equal(lift(t, 3, 3, undefined, 4).elevation, 4);
  assert.equal(lift(t, 3, 3).elevation, 3);
});
