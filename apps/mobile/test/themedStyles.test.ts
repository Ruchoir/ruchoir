import { test } from "node:test";
import assert from "node:assert/strict";

import { styleCache } from "../src/theme/themedStyles.ts";
import { SHAPES } from "../src/theme/tokens.ts";

test("a_shape_builds_its_styles_once", () => {
  let calls = 0;
  const make = styleCache((shape) => {
    calls += 1;
    return { box: { borderRadius: shape.radius.m } };
  });
  const first = make(SHAPES.ruchoir);
  assert.equal(make(SHAPES.ruchoir), first);
  assert.equal(calls, 1);
  assert.equal(first.box.borderRadius, 10);
});

test("a_new_shape_builds_new_styles", () => {
  const make = styleCache((shape) => ({ box: { borderRadius: shape.radius.m } }));
  const ruchoir = make(SHAPES.ruchoir);
  const marine = make(SHAPES.marine);
  assert.notEqual(marine, ruchoir);
  assert.equal(marine.box.borderRadius, 4);
  assert.equal(make(SHAPES.ruchoir), ruchoir);
});
