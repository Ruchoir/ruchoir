import { test } from "node:test";
import assert from "node:assert/strict";

import { invitationRoute } from "../src/accounts/invitation.ts";

const accounts = [
  { id: "a", origin: "https://a.test", status: { kind: "signedIn" } },
  { id: "b", origin: "https://b.test", status: { kind: "signedOut" } },
];

test("an_invitation_to_an_instance_signed_in_switches_to_it", () => {
  assert.deepEqual(invitationRoute(accounts, "https://a.test"), { kind: "switch", id: "a" });
});

test("an_invitation_to_an_instance_signed_out_signs_in_again", () => {
  assert.deepEqual(invitationRoute(accounts, "https://b.test"), { kind: "renew", id: "b" });
});

test("an_invitation_to_an_unknown_instance_adds_it", () => {
  assert.deepEqual(invitationRoute(accounts, "https://c.test"), { kind: "add" });
});
