import { test } from "node:test";
import assert from "node:assert/strict";

import { groupedSecret, otpauthSecret } from "../src/logic/otpauth.ts";

test("the_secret_is_read_from_the_link", () => {
  const url = "otpauth://totp/Ruchoir:camille%40a.test?secret=JBSWY3DPEHPK3PXP&issuer=Ruchoir";
  assert.equal(otpauthSecret(url), "JBSWY3DPEHPK3PXP");
  assert.equal(otpauthSecret("otpauth://totp/x?issuer=R"), null);
  assert.equal(otpauthSecret("https://a.test/?secret=X"), null);
});

test("the_secret_is_shown_in_groups_of_four", () => {
  assert.equal(groupedSecret("JBSWY3DPEHPK3PXP"), "JBSW Y3DP EHPK 3PXP");
});
