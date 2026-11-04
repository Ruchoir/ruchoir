import { test } from "node:test";
import assert from "node:assert/strict";
import { prolongParam, withoutProlong } from "./spaceUrl.ts";

const id = "5a1c0d62-3f0b-4c88-9a5e-0b9d1a2c3d4e";

test("the_mail_button_names_a_guest_by_an_identifier_only", () => {
  assert.equal(prolongParam(`?prolong=${id}`), id);
  assert.equal(prolongParam(`?convert=1&prolong=${id.toUpperCase()}`), id);
  assert.equal(prolongParam("?prolong=../../x"), undefined);
  assert.equal(prolongParam(""), undefined);
});

test("the_prolong_request_leaves_the_address_once_taken", () => {
  assert.equal(withoutProlong(`https://app.example/e/atelier?prolong=${id}`), "/e/atelier");
  assert.equal(withoutProlong(`/e/atelier?a=1&prolong=${id}#x`), "/e/atelier?a=1#x");
});
