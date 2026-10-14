import { test } from "node:test";
import assert from "node:assert/strict";

import { codeComplete, codeDigits, MIN_PASSWORD, passwordLongEnough } from "../src/logic/signup.ts";

test("the_password_rule_is_the_servers", () => {
  assert.equal(MIN_PASSWORD, 12);
  assert.equal(passwordLongEnough("a".repeat(11)), false);
  assert.equal(passwordLongEnough("a".repeat(12)), true);
  // Characters, not bytes: an accented letter counts once.
  assert.equal(passwordLongEnough("é".repeat(12)), true);
  assert.equal(passwordLongEnough("é".repeat(11)), false);
});

test("a_code_keeps_six_digits_whatever_was_typed", () => {
  assert.equal(codeDigits("042 917"), "042917");
  assert.equal(codeDigits("04-29-17-88"), "042917");
  assert.equal(codeDigits("abc"), "");
  assert.equal(codeComplete("042917"), true);
  assert.equal(codeComplete("04291"), false);
});
