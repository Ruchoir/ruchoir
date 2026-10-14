import { test } from "node:test";
import assert from "node:assert/strict";

import { keyboardOverlap, revealOffset } from "../src/logic/keyboard.ts";

// An iPhone 12 mini: 812 points tall, a keyboard of 336 points whose top is at 476.
const KEYBOARD_TOP = 476;

test("a_view_under_a_header_is_raised_by_all_the_keyboard_covers", () => {
  // The conversation's messages start 185 points down, under the header and the tabs, and reach the
  // bottom of the screen: the keyboard covers its last 336 points, not 336 - 185.
  assert.equal(keyboardOverlap({ y: 185, height: 627 }, KEYBOARD_TOP), 336);
});

test("a_sheet_that_starts_lower_is_raised_as_much", () => {
  assert.equal(keyboardOverlap({ y: 54, height: 758 }, KEYBOARD_TOP), 336);
});

test("a_view_above_the_keyboard_is_left_alone", () => {
  assert.equal(keyboardOverlap({ y: 100, height: 300 }, KEYBOARD_TOP), 0);
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
