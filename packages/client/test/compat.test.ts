import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createClient, isInFeed, resetClientForTests, supports } from "../src/index.ts";
import { fakeFetch } from "./fakeFetch.ts";

beforeEach(() => resetClientForTests());

const base = { email_delivery: true, office: { enabled: false, edit: [], view: [], convert: [] } };

test("an_instance_says_its_version_and_what_it_can_do", async () => {
  fakeFetch({ body: { ...base, native_sessions: true, version: "v0.3.0", api_version: 1, features: ["native_sessions", "notification_read"] } });
  const caps = await createClient({ baseUrl: "https://a.test" }).getInstanceCapabilities();
  assert.equal(caps.version, "v0.3.0");
  assert.equal(caps.apiVersion, 1);
  assert.ok(supports(caps, "notification_read"));
  assert.ok(!supports(caps, "something_later"));
});

test("an_older_instance_still_answers_and_lacks_what_it_does_not_name", async () => {
  // v0.2.0 and before: no version, no features, only the booleans of its day.
  fakeFetch({ body: { ...base, native_sessions: true } });
  const caps = await createClient({ baseUrl: "https://a.test" }).getInstanceCapabilities();
  assert.equal(caps.version, undefined);
  assert.equal(caps.apiVersion, 1);
  assert.ok(!supports(caps, "notification_read"));
  // What it said with its booleans still counts.
  assert.ok(supports(caps, "native_sessions"));
});

test("a_newer_instance_with_things_this_app_does_not_know_is_read_as_usual", async () => {
  fakeFetch({ body: { ...base, version: "v9.0.0", api_version: 1, features: ["native_sessions", "teleport"], unknown_field: { x: 1 } } });
  const caps = await createClient({ baseUrl: "https://a.test" }).getInstanceCapabilities();
  assert.ok(supports(caps, "teleport"));
  assert.ok(caps.nativeSessions);
});

test("a_reply_is_in_the_feed_only_when_sent_to_the_channel_too", () => {
  assert.equal(isInFeed({}), true);
  assert.equal(isInFeed({ parentId: "root" }), false);
  assert.equal(isInFeed({ parentId: "root", alsoInChannel: false }), false);
  assert.equal(isInFeed({ parentId: "root", alsoInChannel: true }), true);
});
