import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configureClient, fileDownloadUrl, realtimeSocketUrl, resetClientForTests } from "../src/index.ts";

beforeEach(() => resetClientForTests());

test("download_url_carries_the_base", () => {
  configureClient({ baseUrl: "https://a.test" });
  assert.equal(fileDownloadUrl("f1"), "https://a.test/api/v1/files/f1/download");
});

test("download_url_stays_relative_on_the_web", () => {
  assert.equal(fileDownloadUrl("f1"), "/api/v1/files/f1/download");
});

test("socket_url_follows_the_base", () => {
  configureClient({ baseUrl: "https://a.test" });
  assert.equal(realtimeSocketUrl(), "wss://a.test/api/v1/realtime/ws");
});
