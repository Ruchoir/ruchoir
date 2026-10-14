import { test } from "node:test";
import assert from "node:assert/strict";

import { shownResult } from "../src/data/loadState.ts";

const done = { key: "view:s1:recent", group: "s1", data: ["a"] };

test("the_key_loaded_is_shown", () => {
  assert.deepEqual(shownResult(done, "view:s1:recent", "s1"), { data: ["a"], error: null, loading: false });
});

test("another_view_of_the_same_space_keeps_the_last_one_while_it_loads", () => {
  assert.deepEqual(shownResult(done, "view:s1:starred", "s1"), { data: ["a"], error: null, loading: true });
});

test("another_space_never_shows_the_last_one", () => {
  assert.deepEqual(shownResult(done, "view:s2:recent", "s2"), { data: undefined, error: null, loading: true });
  // Without a group, a new key starts empty, as before.
  assert.deepEqual(shownResult(done, "view:s1:starred", undefined), { data: undefined, error: null, loading: true });
});
