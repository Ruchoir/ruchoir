import { test } from "node:test";
import assert from "node:assert/strict";

import { keyboardOverlap } from "../src/logic/keyboard.ts";

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
