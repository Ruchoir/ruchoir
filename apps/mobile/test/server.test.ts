import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeServer } from "../src/session/server.ts";

test("a_bare_host_gets_https_and_loses_its_capitals_and_spaces", () => {
  assert.deepEqual(normalizeServer("Alpha.Ruchoir.com "), { ok: true, origin: "https://alpha.ruchoir.com" });
});

test("a_path_is_dropped", () => {
  assert.deepEqual(normalizeServer("https://a.test/app/"), { ok: true, origin: "https://a.test" });
});

test("a_port_is_kept", () => {
  assert.deepEqual(normalizeServer("a.test:8443"), { ok: true, origin: "https://a.test:8443" });
});

test("plain_http_is_refused", () => {
  assert.deepEqual(normalizeServer("http://a.test"), { ok: false, reason: "insecure" });
});

test("nothing_is_empty", () => {
  assert.deepEqual(normalizeServer("   "), { ok: false, reason: "empty" });
});

test("words_are_not_a_host", () => {
  assert.deepEqual(normalizeServer("not a host"), { ok: false, reason: "invalid" });
  assert.deepEqual(normalizeServer("ftp://a.test"), { ok: false, reason: "invalid" });
  assert.deepEqual(normalizeServer("localhost"), { ok: false, reason: "invalid" });
});
