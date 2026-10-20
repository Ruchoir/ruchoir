import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configureClient, createClient, fileDownloadUrl, getWorkspaces, resetClientForTests } from "../src/index.ts";
import { fakeFetch, header } from "./fakeFetch.ts";

beforeEach(() => resetClientForTests());

const bearer = (token: string) => () => `Bearer ${token}`;

test("two_clients_never_cross_addresses_or_tokens", async () => {
  const calls = fakeFetch({ body: [] }, { body: [] });
  const a = createClient({ baseUrl: "https://a.test", authorization: bearer("A") });
  const b = createClient({ baseUrl: "https://b.test/", authorization: bearer("B") });
  await b.getWorkspaces();
  await a.getWorkspaces();
  assert.equal(calls[0].url, "https://b.test/api/v1/me/spaces");
  assert.equal(header(calls[0], "authorization"), "Bearer B");
  assert.equal(calls[1].url, "https://a.test/api/v1/me/spaces");
  assert.equal(header(calls[1], "authorization"), "Bearer A");
  assert.equal(calls[1].init.credentials, "omit");
});

test("a_request_finishes_on_its_own_instance_when_the_default_moves", async () => {
  const calls = fakeFetch({ body: [] });
  const a = createClient({ baseUrl: "https://a.test", authorization: bearer("A") });
  const pending = a.getWorkspaces();
  configureClient({ baseUrl: "https://b.test", authorization: bearer("B") });
  await pending;
  assert.equal(calls[0].url, "https://a.test/api/v1/me/spaces");
  assert.equal(header(calls[0], "authorization"), "Bearer A");
});

test("a_client_builds_urls_on_its_base", () => {
  const a = createClient({ baseUrl: "https://a.test" });
  assert.equal(a.fileDownloadUrl("f1"), "https://a.test/api/v1/files/f1/download");
  assert.equal(a.absoluteUrl("/api/v1/users/u1/avatar"), "https://a.test/api/v1/users/u1/avatar");
  assert.equal(a.realtimeSocketUrl(), "wss://a.test/api/v1/realtime/ws");
  // The default client is untouched by it.
  assert.equal(fileDownloadUrl("f1"), "/api/v1/files/f1/download");
});

test("a_401_is_told_to_the_client_that_got_it", async () => {
  fakeFetch({ status: 401, body: { error: "unauthorized" } });
  const heard: string[] = [];
  configureClient({ onUnauthorized: () => heard.push("default") });
  const a = createClient({ baseUrl: "https://a.test", onUnauthorized: () => heard.push("a") });
  await assert.rejects(a.getWorkspaces());
  assert.deepEqual(heard, ["a"]);
});

test("the_default_client_follows_configure_client", async () => {
  const calls = fakeFetch({ body: [] });
  configureClient({ baseUrl: "https://c.test", authorization: bearer("C") });
  await getWorkspaces();
  assert.equal(calls[0].url, "https://c.test/api/v1/me/spaces");
  assert.equal(header(calls[0], "authorization"), "Bearer C");
});

test("configure_changes_one_client_only", async () => {
  const calls = fakeFetch({ body: [] }, { body: [] });
  const a = createClient({ baseUrl: "https://a.test", authorization: bearer("A") });
  const b = createClient({ baseUrl: "https://b.test", authorization: bearer("B") });
  a.configure({ authorization: bearer("A2") });
  await a.getWorkspaces();
  await b.getWorkspaces();
  assert.equal(header(calls[0], "authorization"), "Bearer A2");
  assert.equal(header(calls[1], "authorization"), "Bearer B");
});
