import { test } from "node:test";
import assert from "node:assert/strict";

import { spaceStatus } from "../src/space/status.ts";

test("not_loaded_yet_is_loading", () => {
  assert.equal(spaceStatus(undefined), "loading");
});

test("an_empty_list_means_no_space_rather_than_waiting_forever", () => {
  assert.equal(spaceStatus([]), "none");
});

test("one_space_is_ready", () => {
  assert.equal(spaceStatus([{ id: "s1" }] as never), "ready");
});
