// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { apiRequest, configureClient, resetClientForTests } from "../src/index.ts";
import { fakeFetch, header } from "./fakeFetch.ts";

beforeEach(() => resetClientForTests());

test("requests_join_base_url_and_api_prefix", async () => {
  const calls = fakeFetch({ body: { ok: true } });
  configureClient({ baseUrl: "https://a.test" });
  await apiRequest("GET", "/auth/session");
  assert.equal(calls[0].url, "https://a.test/api/v1/auth/session");
});

test("bearer_is_sent_when_configured", async () => {
  const calls = fakeFetch({ body: {} });
  configureClient({ baseUrl: "https://a.test", authorization: () => "Bearer t1" });
  await apiRequest("GET", "/me/spaces");
  assert.equal(header(calls[0], "authorization"), "Bearer t1");
  assert.equal(calls[0].init.credentials, "omit");
});

test("web_defaults_stay_same_origin", async () => {
  const calls = fakeFetch({ body: {} });
  await apiRequest("GET", "/me/spaces");
  assert.equal(calls[0].url, "/api/v1/me/spaces");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(header(calls[0], "authorization"), null);
});

test("a_401_calls_onUnauthorized_once", async () => {
  fakeFetch({ status: 401, body: { error: "unauthorized" } });
  let seen = 0;
  configureClient({ baseUrl: "https://a.test", onUnauthorized: () => seen++ });
  await assert.rejects(apiRequest("GET", "/auth/session"), (err: { status: number }) => err.status === 401);
  assert.equal(seen, 1);
});

test("a_204_resolves_undefined", async () => {
  fakeFetch({ status: 204 });
  assert.equal(await apiRequest("POST", "/auth/logout"), undefined);
});
