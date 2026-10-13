import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configureClient, login, resetClientForTests, verifyRecoveryCode } from "../src/index.ts";
import { fakeFetch } from "./fakeFetch.ts";

beforeEach(() => resetClientForTests());

const USER = { id: "u1", email: "camille@a.test", display_name: "Camille Roux", active: true };

test("login_asks_for_a_token_when_configured", async () => {
  const calls = fakeFetch({ body: { ...USER, session_token: "s1" } });
  configureClient({ baseUrl: "https://a.test", sessionDelivery: "token" });
  const result = await login("camille@a.test", "pw");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    email: "camille@a.test",
    password: "pw",
    session_delivery: "token",
  });
  assert.equal(result.kind, "authenticated");
  assert.equal(result.kind === "authenticated" && result.sessionToken, "s1");
});

test("login_leaves_the_web_body_unchanged", async () => {
  const calls = fakeFetch({ body: USER });
  const result = await login("camille@a.test", "pw");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { email: "camille@a.test", password: "pw" });
  assert.equal(result.kind === "authenticated" && result.sessionToken, undefined);
});

test("login_maps_an_mfa_challenge", async () => {
  fakeFetch({ body: { mfa_required: true, methods: ["totp", "recovery", "something_new"], mfa_token: "m1" } });
  const result = await login("camille@a.test", "pw");
  assert.deepEqual(result, { kind: "mfa", methods: ["totp", "recovery"], mfaToken: "m1" });
});

test("recovery_verify_returns_the_token", async () => {
  fakeFetch({ body: { ...USER, session_token: "s2" } });
  configureClient({ baseUrl: "https://a.test", sessionDelivery: "token" });
  const result = await verifyRecoveryCode("m1", "abcd-efgh-jkmn");
  assert.equal(result.user.email, "camille@a.test");
  assert.equal(result.sessionToken, "s2");
});
