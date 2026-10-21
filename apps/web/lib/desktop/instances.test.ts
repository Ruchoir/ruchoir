import { test } from "node:test";
import assert from "node:assert/strict";

import { shortLabel } from "./instances.ts";

test("an_instance_is_named_by_the_telling_part_of_its_host", () => {
  assert.equal(shortLabel("ruchoir.boulot.fr"), "boulot");
  assert.equal(shortLabel("asso-chorale.org"), "asso-chorale");
  assert.equal(shortLabel("alpha.ruchoir.com"), "alpha");
  assert.equal(shortLabel("ruchoir-dev.theovilain.fr"), "ruchoir-dev");
  assert.equal(shortLabel("www.example.org"), "example");
  assert.equal(shortLabel("localhost:8443"), "localhost");
  assert.equal(shortLabel("ruchoir.com"), "ruchoir");
});
