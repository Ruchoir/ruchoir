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

test("a_401_tells_why", async () => {
  fakeFetch({ status: 401, body: { error: "invalid_credentials", message: "Invalid email or password." } });
  const codes: (string | undefined)[] = [];
  configureClient({ baseUrl: "https://a.test", onUnauthorized: (code) => codes.push(code) });
  // A wrong current password is a 401 too, and says so: the session itself is fine.
  await assert.rejects(apiRequest("POST", "/auth/password", {}));
  assert.deepEqual(codes, ["invalid_credentials"]);
});

test("a_write_refused_by_a_preview_calls_onPreviewReadOnly", async () => {
  fakeFetch({ status: 403, body: { error: "preview_read_only" } }, { status: 403, body: { error: "forbidden", reason: "preview_read_only" } }, { status: 403, body: { error: "forbidden", reason: "cannot_grant" } });
  const heard: string[] = [];
  configureClient({ baseUrl: "https://a.test", onPreviewReadOnly: (request) => heard.push(`${request.method} ${request.path}`) });
  for (let i = 0; i < 3; i++) await apiRequest("PUT", "/x").catch(() => {});
  assert.deepEqual(heard, ["PUT /x", "PUT /x"]);
});

test("a_preview_sends_no_background_write_and_toasts_nothing_unasked", async () => {
  const heard: string[] = [];
  let previewing = true;
  configureClient({ baseUrl: "https://a.test", previewActive: () => previewing, onPreviewReadOnly: (request) => heard.push(`${request.method} ${request.path}`) });
  const background = [
    ["PUT", "/conversations/c1/read"], ["PUT", "/notifications/n1/read?guest_notices=true"], ["PUT", "/notifications/read"],
    ["POST", "/realtime/typing"], ["PUT", "/push/devices"], ["PUT", "/push/subscription"], ["POST", "/files/f1/office/heartbeat?tab=t"],
  ] as const;
  // While previewing none of them leaves the client, and nothing is heard.
  const calls = fakeFetch();
  for (const [method, path] of background) await apiRequest(method, path);
  assert.equal(calls.length, 0);
  assert.deepEqual(heard, []);
  // What the person starts is sent, and its refusal is heard.
  fakeFetch({ status: 403, body: { error: "preview_read_only" } });
  await apiRequest("POST", "/conversations/c1/messages").catch(() => {});
  assert.deepEqual(heard, ["POST /conversations/c1/messages"]);
  // Reads are never held back.
  const reads = fakeFetch({ body: {} });
  await apiRequest("GET", "/conversations/c1/read");
  assert.equal(reads.length, 1);
  // Before the preview is known, a background write goes out; if the server refuses it, silently.
  previewing = false;
  fakeFetch({ status: 403, body: { error: "preview_read_only" } });
  await apiRequest("PUT", "/conversations/c1/read").catch(() => {});
  assert.deepEqual(heard, ["POST /conversations/c1/messages"]);
  // Outside a preview everything is sent as before.
  const normal = fakeFetch({ body: {} });
  await apiRequest("PUT", "/conversations/c1/read");
  assert.equal(normal.length, 1);
});

test("a_get_refused_for_rate_is_tried_once_more_after_the_wait_the_server_names", async () => {
  const calls = fakeFetch({ status: 429, body: { error: "rate_limited", retry_after: 0 } }, { body: { ok: true } });
  assert.deepEqual(await apiRequest("GET", "/me/spaces"), { ok: true });
  assert.equal(calls.length, 2);
});

test("a_second_429_is_the_answer_and_a_write_is_never_repeated", async () => {
  const calls = fakeFetch({ status: 429, body: { error: "rate_limited", retry_after: 0 } }, { status: 429, body: { error: "rate_limited", retry_after: 0 } });
  await assert.rejects(apiRequest("GET", "/x"), (err: { status: number }) => err.status === 429);
  assert.equal(calls.length, 2);
  const writes = fakeFetch({ status: 429, body: { error: "rate_limited", retry_after: 0 } }, { body: {} });
  await assert.rejects(apiRequest("POST", "/x", {}), (err: { status: number }) => err.status === 429);
  assert.equal(writes.length, 1);
});

test("a_long_wait_is_not_waited_for", async () => {
  const calls = fakeFetch({ status: 429, body: { error: "rate_limited", retry_after: 60 } }, { body: {} });
  await assert.rejects(apiRequest("GET", "/x"), (err: { status: number }) => err.status === 429);
  assert.equal(calls.length, 1);
});
