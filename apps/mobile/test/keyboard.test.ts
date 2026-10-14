import { test } from "node:test";
import assert from "node:assert/strict";

import { areaPadding, revealOffset } from "../src/logic/keyboard.ts";

// An iPhone 12 mini: a keyboard of 336 points, a home indicator area of 34.

test("with_the_keyboard_up_an_area_rises_by_all_of_it", () => {
  // Wherever the area starts (under a header, in a sheet that begins lower), it reaches the bottom
  // of the screen, so the keyboard covers exactly its height of it.
  assert.equal(areaPadding(336, 34), 336);
});

test("with_the_keyboard_down_an_area_keeps_clear_of_the_home_indicator", () => {
  assert.equal(areaPadding(0, 34), 34);
  assert.equal(areaPadding(0, 0), 0);
});

test("a_field_under_the_keyboard_scrolls_up_into_sight", () => {
  // The form shows 200..450 in the window; the field sits at 500..552, the form scrolled by 40.
  assert.equal(revealOffset({ y: 500, height: 52 }, { y: 200, height: 250 }, 40), 40 + (552 + 16 - 450));
});

test("a_field_above_the_visible_part_scrolls_down_into_sight", () => {
  assert.equal(revealOffset({ y: 150, height: 52 }, { y: 200, height: 250 }, 300), 300 - (200 - (150 - 16)));
});

test("a_field_already_in_sight_does_not_move", () => {
  assert.equal(revealOffset({ y: 260, height: 52 }, { y: 200, height: 250 }, 40), null);
});
