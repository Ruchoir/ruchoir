import { test } from "node:test";
import assert from "node:assert/strict";

import { PASSKEY_RETURN, SIGN_IN_RETURN, passkeyUrl, redirectParams, signInUrl, toHex } from "../src/logic/handoff.ts";

test("the_sign_in_page_carries_the_challenge_and_the_address", () => {
  assert.equal(
    signInUrl("https://ruchoir.example", "ab".repeat(32), "léa+test@atelier.fr"),
    `https://ruchoir.example/n/?c=${"ab".repeat(32)}&e=l%C3%A9a%2Btest%40atelier.fr`,
  );
  assert.equal(signInUrl("https://ruchoir.example/", "cd".repeat(32)), `https://ruchoir.example/n/?c=${"cd".repeat(32)}`);
});

test("the_passkey_page_carries_the_code", () => {
  assert.equal(passkeyUrl("https://ruchoir.example", "a b"), "https://ruchoir.example/n/?h=a%20b");
});

test("only_the_expected_return_is_read", () => {
  assert.deepEqual(redirectParams(`${SIGN_IN_RETURN}?code=xyz`, SIGN_IN_RETURN), { code: "xyz" });
  assert.deepEqual(redirectParams(`${SIGN_IN_RETURN}?cancelled=1`, SIGN_IN_RETURN), { cancelled: "1" });
  assert.deepEqual(redirectParams(PASSKEY_RETURN, PASSKEY_RETURN), {});
  assert.equal(redirectParams(`${PASSKEY_RETURN}?added=1`, SIGN_IN_RETURN), null);
  assert.equal(redirectParams(`${SIGN_IN_RETURN}extra?code=xyz`, SIGN_IN_RETURN), null);
  assert.equal(redirectParams("https://evil.example/?code=xyz", SIGN_IN_RETURN), null);
});

test("random_bytes_become_lowercase_hex", () => {
  assert.equal(toHex(new Uint8Array([0, 15, 16, 255])), "000f10ff");
});
