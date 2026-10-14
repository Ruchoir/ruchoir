import { test } from "node:test";
import assert from "node:assert/strict";

import { sessionReducer, type SessionState } from "../src/session/machine.ts";

const USER = { id: "u1", email: "camille@a.test", name: "Camille Roux" } as never;
const signedIn: SessionState = { kind: "signedIn", server: "https://a.test", user: USER };

test("restored_with_a_user_is_signed_in", () => {
  const state = sessionReducer({ kind: "booting" }, { type: "restored", server: "https://a.test", user: USER });
  assert.deepEqual(state, signedIn);
});

test("restored_without_a_server_asks_for_one", () => {
  assert.deepEqual(sessionReducer({ kind: "booting" }, { type: "restored", server: null, user: null }), {
    kind: "needsServer",
  });
});

test("unauthorized_from_signedIn_goes_to_signedOut_with_reason_expired", () => {
  assert.deepEqual(sessionReducer(signedIn, { type: "unauthorized" }), {
    kind: "signedOut",
    server: "https://a.test",
    reason: "expired",
  });
});

test("unauthorized_twice_stays_signedOut", () => {
  const once = sessionReducer(signedIn, { type: "unauthorized" });
  // The same object, so a second 401 in flight does not render the sign-in screen again.
  assert.equal(sessionReducer(once, { type: "unauthorized" }), once);
});

test("mfaRequired_then_authenticated_signs_in", () => {
  const out: SessionState = { kind: "signedOut", server: "https://a.test" };
  const mfa = sessionReducer(out, { type: "mfaRequired", mfaToken: "m1", methods: ["totp", "recovery"] });
  assert.deepEqual(mfa, { kind: "mfa", server: "https://a.test", mfaToken: "m1", methods: ["totp", "recovery"] });
  assert.deepEqual(sessionReducer(mfa, { type: "authenticated", user: USER }), signedIn);
});

test("signedOut_keeps_the_server", () => {
  assert.deepEqual(sessionReducer(signedIn, { type: "signedOut" }), { kind: "signedOut", server: "https://a.test" });
});

test("changing_server_forgets_the_old_one", () => {
  assert.deepEqual(sessionReducer({ kind: "signedOut", server: "https://a.test" }, { type: "changeServer" }), {
    kind: "needsServer",
  });
});

test("back_from_the_second_factor_returns_to_the_password", () => {
  const mfa: SessionState = { kind: "mfa", server: "https://a.test", mfaToken: "t", methods: ["totp"] };
  assert.deepEqual(sessionReducer(mfa, { type: "signedOut" }), { kind: "signedOut", server: "https://a.test", reason: "signIn" });
});

test("signing_out_opens_the_welcome", () => {
  assert.deepEqual(sessionReducer(signedIn, { type: "signedOut" }), { kind: "signedOut", server: "https://a.test" });
});
