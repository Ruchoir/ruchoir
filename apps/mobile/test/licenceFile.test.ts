import { test } from "node:test";
import assert from "node:assert/strict";

import { checkLicence, knownFileSize, LICENCE_MAX_BYTES, seatsFraction } from "../src/logic/licenceFile.ts";

const GOOD = "RUCHOIR-LICENCE-1.eyJhIjoxfQ.MEUCIQDk3vZ1c9mXq0hT8aYpL2sN";

test("a_licence_file_with_a_known_extension_passes_whatever_its_case", () => {
  for (const name of ["a.txt", "A.LIC", "atelier.Licence", "my.licence.txt"]) {
    assert.equal(checkLicence({ name, text: GOOD }), null, name);
  }
});

test("a_text_plain_mime_passes_without_an_extension", () => {
  assert.equal(checkLicence({ name: "licence", mime: "text/plain", text: GOOD }), null);
  assert.equal(checkLicence({ name: "licence", mime: "Text/Plain; charset=utf-8", text: GOOD }), null);
});

test("another_extension_or_type_is_refused", () => {
  assert.equal(checkLicence({ name: "photo.png", mime: "image/png", text: GOOD }), "type");
  assert.equal(checkLicence({ name: "licence", mime: "application/octet-stream", text: GOOD }), "type");
  assert.equal(checkLicence({ name: "licence.lic.exe", text: GOOD }), "type");
  assert.equal(checkLicence({ name: "licence", text: GOOD }), "type");
});

test("a_file_over_64_kb_is_refused_by_its_size_or_by_its_text", () => {
  assert.equal(LICENCE_MAX_BYTES, 64 * 1024);
  assert.equal(checkLicence({ name: "a.txt", size: LICENCE_MAX_BYTES + 1, text: GOOD }), "size");
  assert.equal(checkLicence({ name: "a.txt", size: LICENCE_MAX_BYTES, text: GOOD }), null);
  assert.equal(checkLicence({ name: "a.txt", text: "x".repeat(LICENCE_MAX_BYTES + 1) }), "size");
  // Two bytes per letter: 40 000 letters are 80 000 bytes.
  assert.equal(checkLicence({ name: "a.txt", text: "é".repeat(40_000) }), "size");
});

test("an_empty_file_or_one_of_blanks_is_refused", () => {
  assert.equal(checkLicence({ name: "a.txt", size: 0, text: "" }), "empty");
  assert.equal(checkLicence({ name: "a.txt", text: " \n\t \r\n" }), "empty");
});

test("a_file_that_is_not_text_is_refused", () => {
  assert.equal(checkLicence({ name: "a.lic", text: `RUCHOIR\u0000\u0001abc` }), "notText");
  assert.equal(checkLicence({ name: "a.lic", text: "���" }), "notText");
});

test("pasted_text_has_no_name_and_gets_the_same_size_empty_and_text_checks", () => {
  assert.equal(checkLicence({ text: GOOD }), null);
  assert.equal(checkLicence({ text: "   " }), "empty");
  assert.equal(checkLicence({ text: "a\u0000b" }), "notText");
  assert.equal(checkLicence({ text: "x".repeat(LICENCE_MAX_BYTES + 1) }), "size");
});

test("the_order_of_refusals_is_type_then_size_then_empty_then_text", () => {
  assert.equal(checkLicence({ name: "a.png", size: LICENCE_MAX_BYTES + 1, text: "" }), "type");
  assert.equal(checkLicence({ name: "a.txt", size: LICENCE_MAX_BYTES + 1, text: "" }), "size");
});

test("the_seats_bar_is_the_share_used_kept_between_zero_and_one", () => {
  assert.deepEqual(seatsFraction(12, 25), { fraction: 0.48, full: false });
  assert.deepEqual(seatsFraction(25, 25), { fraction: 1, full: true });
  assert.deepEqual(seatsFraction(30, 25), { fraction: 1, full: true });
  assert.deepEqual(seatsFraction(0, 25), { fraction: 0, full: false });
  assert.deepEqual(seatsFraction(3, 0), { fraction: 1, full: true });
});

test("a_file_whose_size_nobody_knows_is_never_read", () => {
  assert.equal(knownFileSize(undefined, undefined), null);
  assert.equal(knownFileSize(null, Number.NaN), null);
  assert.equal(knownFileSize(undefined, 1200), 1200);
  assert.equal(knownFileSize(300, 1200), 300);
  assert.equal(knownFileSize(0, 1200), 0);
  assert.equal(knownFileSize(-1, undefined), null);
});
