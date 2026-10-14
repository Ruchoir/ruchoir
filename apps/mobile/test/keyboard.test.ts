import { test } from "node:test";
import assert from "node:assert/strict";

import { COMPOSER_GAP, areaPadding, areaPlacement, composerRoom, revealOffset } from "../src/logic/keyboard.ts";

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

test("a_rising_keyboard_lifts_a_form_only_once_it_reaches_it", () => {
  // Its first frames stay within the home indicator's area: the form's footer waits for it.
  assert.equal(areaPadding(20, 34), 34);
  assert.equal(areaPadding(120, 34), 120);
});

test("a_composer_keeps_clear_of_the_home_indicator_or_a_small_gap_without_one", () => {
  assert.equal(composerRoom(34), 34);
  assert.equal(composerRoom(0), COMPOSER_GAP);
});

test("a_composer_s_room_for_the_home_indicator_goes_behind_the_keyboard", () => {
  // The bar keeps its 34 under it: the keyboard covers 26 of them, 8 stay above it.
  const overlap = composerRoom(34) - COMPOSER_GAP;
  assert.equal(areaPadding(336, 0, overlap), 310);
  assert.equal(areaPadding(10, 0, overlap), 0);
});

test("a_chat_slides_with_a_moving_keyboard_without_being_laid_out_again", () => {
  assert.deepEqual(areaPlacement(200, 0, 26, true, true), { padding: 0, shift: -174 });
  assert.deepEqual(areaPlacement(200, 34, 0, true, true), { padding: 34, shift: -166 });
});

test("a_chat_is_laid_out_above_the_keyboard_once_it_rests", () => {
  assert.deepEqual(areaPlacement(336, 0, 26, true, false), { padding: 310, shift: 0 });
  assert.deepEqual(areaPlacement(0, 0, 26, true, false), { padding: 0, shift: 0 });
});

test("an_area_that_does_not_slide_is_laid_out_at_every_frame", () => {
  assert.deepEqual(areaPlacement(200, 34, 0, false, true), { padding: 200, shift: 0 });
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
