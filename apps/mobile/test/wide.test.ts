import { test } from "node:test";
import assert from "node:assert/strict";

import { isTablet, isWide } from "../src/layout/wide.ts";

test("a_phone_is_not_a_tablet_whichever_way_it_is_held", () => {
  assert.equal(isTablet(390, 844), false);
  assert.equal(isTablet(844, 390), false);
  assert.equal(isTablet(430, 932), false);
});

test("an_ipad_or_an_android_tablet_is_one", () => {
  assert.equal(isTablet(820, 1180), true);
  assert.equal(isTablet(1280, 800), true);
  assert.equal(isTablet(744, 1133), true);
});

test("the_wide_layout_needs_room", () => {
  assert.equal(isWide(1180), true);
  assert.equal(isWide(820), true);
  assert.equal(isWide(694), false, "an iPad in split view, two thirds");
  assert.equal(isWide(390), false);
});
