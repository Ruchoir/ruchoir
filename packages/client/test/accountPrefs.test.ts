// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createClient, mergePending, reconcileAccountPrefs, resetClientForTests } from "../src/index.ts";
import { fakeFetch } from "./fakeFetch.ts";

beforeEach(() => resetClientForTests());

const KEYS = ["locale", "font", "calendar_duration"] as const;

test("reconcile_pushes_local_when_the_server_is_empty", () => {
  const out = reconcileAccountPrefs({
    local: { locale: "fr", font: "system", calendar_duration: 30 },
    server: {},
    keys: KEYS,
    shared: false,
  });
  assert.deepEqual(out.apply, {});
  assert.deepEqual(out.push, { locale: "fr", font: "system", calendar_duration: 30 });
});

test("reconcile_server_wins_once_it_holds_something", () => {
  const out = reconcileAccountPrefs({
    local: { locale: "fr", font: "system" },
    server: { locale: "en" },
    keys: KEYS,
    shared: false,
  });
  // What the server does not hold goes back to its default, not to this device's old value.
  assert.deepEqual(out.apply, { locale: "en", font: null, calendar_duration: null });
  assert.deepEqual(out.push, {});
});

test("reconcile_never_touches_unknown_keys", () => {
  // The phone knows only its keys: the web's rail order is neither applied nor sent.
  const out = reconcileAccountPrefs({
    local: { locale: "fr", space_order: ["a"] },
    server: { locale: "en", space_order: ["b"] },
    keys: KEYS,
    shared: false,
  });
  assert.equal("space_order" in out.apply, false);
  assert.equal("space_order" in out.push, false);
  const first = reconcileAccountPrefs({ local: { space_order: ["a"] }, server: { space_order: ["b"] }, keys: KEYS, shared: false });
  // The server holds none of this app's keys: the local ones go up, and only those.
  assert.deepEqual(first.push, {});
  assert.deepEqual(first.apply, {});
});

test("reconcile_shared_pushes_only_differences", () => {
  const out = reconcileAccountPrefs({
    local: { locale: "fr", font: "dyslexic", calendar_duration: 60 },
    server: { locale: "fr", font: "plex" },
    keys: KEYS,
    shared: true,
  });
  assert.deepEqual(out.apply, {});
  assert.deepEqual(out.push, { font: "dyslexic", calendar_duration: 60 });
});

test("merge_pending_keeps_the_last", () => {
  assert.deepEqual(mergePending({ locale: "fr", font: "plex" }, { locale: "en", calendar_duration: null }), {
    locale: "en",
    font: "plex",
    calendar_duration: null,
  });
});

test("an_older_server_reads_as_no_preferences_at_all", async () => {
  fakeFetch({ status: 404, body: { error: "not_found", message: "Resource not found." } });
  const client = createClient({ baseUrl: "https://a.test" });
  assert.equal(await client.getAccountPreferences(), null);
});

test("a_change_sends_only_its_keys", async () => {
  const calls = fakeFetch({ body: { locale: "en", font: "plex" } }, { status: 204 });
  const client = createClient({ baseUrl: "https://a.test" });
  const doc = await client.patchAccountPreferences({ locale: "en" });
  assert.deepEqual(doc, { locale: "en", font: "plex" });
  assert.equal(calls[0].url, "https://a.test/api/v1/me/preferences");
  assert.equal(calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { locale: "en" });

  await client.setDmHidden("dm-1", true);
  assert.equal(calls[1].url, "https://a.test/api/v1/me/dms/dm-1/hidden");
  assert.equal(calls[1].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { hidden: true });
});

test("a_direct_message_says_whether_it_is_hidden", async () => {
  fakeFetch({
    body: [
      { id: "d1", name: "Bob", is_group: false, bot: false, unread: 0, hidden: true },
      { id: "d2", name: "Carol", is_group: false, bot: false, unread: 0 },
    ],
  });
  const dms = await createClient({ baseUrl: "https://a.test" }).getDirectMessages("space-1");
  assert.equal(dms[0].hidden, true);
  // An older server never says: nothing is hidden there.
  assert.equal(dms[1].hidden, false);
});
