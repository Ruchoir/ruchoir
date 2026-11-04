import { test } from "node:test";
import assert from "node:assert/strict";

import { createGroupStore, mayListGroups } from "../src/logic/mentionGroups.ts";

const g = (id: string) => ({ id, name: id }) as never;

test("only_someone_who_may_read_the_groups_asks_for_them", () => {
  const member = { role: "member", myPermissions: ["members.view", "messages.send"] };
  assert.equal(mayListGroups(member, true), true);
  // The route is members.view only: a role without it would get a 403 on every screen.
  assert.equal(mayListGroups({ role: "member", myPermissions: ["messages.send"] }, true), false);
  assert.equal(mayListGroups({ role: "guest", myPermissions: ["members.view"] }, true), false);
  // An instance that does not know the permissions has no groups route.
  assert.equal(mayListGroups(member, false), false);
  assert.equal(mayListGroups(undefined, true), false);
  // An older owner without a permission list holds everything.
  assert.equal(mayListGroups({ role: "owner" }, true), true);
});

test("one_request_serves_every_screen_of_a_space", async () => {
  const calls: string[] = [];
  const store = createGroupStore<object>(async (_c, space) => {
    calls.push(space);
    return [g("a")];
  });
  const client = {};
  const seenA: unknown[] = [];
  const seenB: unknown[] = [];
  const a = store.watch(client, "s1", () => seenA.push(store.read(client, "s1")));
  const b = store.watch(client, "s1", () => seenB.push(store.read(client, "s1")));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ["s1"]);
  assert.equal(seenA.length, 1);
  assert.equal(seenB.length, 1);
  assert.deepEqual(store.read(client, "s1"), [g("a")]);
  // Another space, another instance: their own entry.
  store.watch(client, "s2", () => {});
  store.watch({}, "s1", () => {});
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ["s1", "s2", "s1"]);
  a();
  b();
});

test("a_reload_asks_again_and_tells_every_watcher", async () => {
  let n = 0;
  const store = createGroupStore<object>(async () => [g(`v${++n}`)]);
  const client = {};
  let told = 0;
  const stop = store.watch(client, "s1", () => told++);
  await new Promise((r) => setTimeout(r, 0));
  store.reload(client, "s1");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(store.read(client, "s1"), [g("v2")]);
  assert.equal(told, 2);
  stop();
});

test("the_last_watcher_to_leave_cancels_the_request", async () => {
  let signal: AbortSignal | undefined;
  const store = createGroupStore<object>((_c, _s, s) => {
    signal = s;
    return new Promise(() => {});
  });
  const client = {};
  const a = store.watch(client, "s1", () => {});
  const b = store.watch(client, "s1", () => {});
  a();
  assert.equal(signal?.aborted, false);
  b();
  assert.equal(signal?.aborted, true);
});

test("a_refusal_keeps_what_was_known_and_nothing_is_thrown", async () => {
  let fail = false;
  const store = createGroupStore<object>(async () => {
    if (fail) throw new Error("403");
    return [g("a")];
  });
  const client = {};
  const stop = store.watch(client, "s1", () => {});
  await new Promise((r) => setTimeout(r, 0));
  fail = true;
  store.reload(client, "s1");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(store.read(client, "s1"), [g("a")]);
  stop();
});
