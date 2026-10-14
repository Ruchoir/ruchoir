import { test } from "node:test";
import assert from "node:assert/strict";

import { addAddress, isEmail } from "../src/logic/email.ts";

test("an_address_needs_a_name_a_domain_and_a_dot", () => {
  assert.equal(isEmail("lea@atelier.fr"), true);
  assert.equal(isEmail(" lea@atelier.fr "), true);
  assert.equal(isEmail("lea@atelier"), false);
  assert.equal(isEmail("lea atelier.fr"), false);
});

test("adding_an_address_trims_it_and_keeps_each_once_whatever_its_case", () => {
  assert.deepEqual(addAddress(["lea@atelier.fr"], "  Hugo@Atelier.fr "), ["lea@atelier.fr", "Hugo@Atelier.fr"]);
  assert.deepEqual(addAddress(["lea@atelier.fr"], "LEA@atelier.fr"), ["lea@atelier.fr"]);
});
