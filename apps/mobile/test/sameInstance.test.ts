import { test } from "node:test";
import assert from "node:assert/strict";

import { isInstanceUrl } from "../src/api/sameInstance.ts";

const ORIGIN = "https://a.test";

test("a_path_or_the_instance_itself_gets_the_token", () => {
  assert.equal(isInstanceUrl("/api/v1/users/u1/avatar", ORIGIN), true);
  assert.equal(isInstanceUrl("https://a.test/api/v1/files/f1/download", ORIGIN), true);
});

test("another_host_never_gets_the_token", () => {
  assert.equal(isInstanceUrl("https://images.example.com/a.png", ORIGIN), false);
  assert.equal(isInstanceUrl("https://a.test.evil.com/x", ORIGIN), false);
  assert.equal(isInstanceUrl("https://a.test:8443/x", ORIGIN), false);
  assert.equal(isInstanceUrl("//a.test/x", ORIGIN), false);
  assert.equal(isInstanceUrl("data:image/png;base64,AAAA", ORIGIN), false);
});

test("no_instance_means_no_token", () => {
  assert.equal(isInstanceUrl("/api/v1/x", null), false);
});
