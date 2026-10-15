import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_FAILURES, PIN_LENGTH, failuresLeft, isPin, lockedOut, pressKey, readFlag, setupNext } from "../src/logic/pin.ts";

test("a_pin_is_six_digits", () => {
  assert.equal(PIN_LENGTH, 6);
  assert.equal(isPin("042917"), true);
  assert.equal(isPin("04291"), false);
  assert.equal(isPin("0429170"), false);
  assert.equal(isPin("04 917"), false);
  assert.equal(isPin("٠٤٢٩١٧"), false, "Arabic-Indic digits are not what the keypad types");
});

test("the_keypad_types_digits_up_to_six_and_erases_the_last", () => {
  assert.equal(pressKey("", "4"), "4");
  assert.equal(pressKey("12345", "6"), "123456");
  assert.equal(pressKey("123456", "7"), "123456", "a seventh digit is ignored");
  assert.equal(pressKey("123", "erase"), "12");
  assert.equal(pressKey("", "erase"), "");
  assert.equal(pressKey("12", "x"), "12", "anything else is ignored");
});

test("five_wrong_pins_sign_out", () => {
  assert.equal(MAX_FAILURES, 5);
  assert.equal(failuresLeft(0), 5);
  assert.equal(failuresLeft(4), 1);
  assert.equal(failuresLeft(7), 0);
  assert.equal(lockedOut(4), false);
  assert.equal(lockedOut(5), true);
});

test("the_stored_flag_reads_off_on_or_reset", () => {
  assert.equal(readFlag(null), "off");
  assert.equal(readFlag("1"), "on");
  assert.equal(readFlag("reset"), "reset");
  assert.equal(readFlag("something else"), "off");
});

test("a_new_pin_is_typed_twice", () => {
  const first = setupNext({ step: "choose" }, "135790");
  assert.deepEqual(first, { setup: { step: "confirm", first: "135790" } });
  assert.deepEqual(setupNext(first.setup, "135790"), { setup: { step: "choose" }, pin: "135790" });
});

test("two_different_pins_start_over", () => {
  assert.deepEqual(setupNext({ step: "confirm", first: "135790" }, "135791"), { setup: { step: "choose" }, mismatch: true });
});
