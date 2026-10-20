import { test } from "node:test";
import assert from "node:assert/strict";

import { fromEvery, parseSharedAccounts, serializeSharedAccounts } from "../src/push/shared.ts";

const A = { server: "https://a.test", token: "ta" };
const B = { server: "https://b.test", token: "tb" };

test("the_list_reads_back_as_written", () => {
  assert.deepEqual(parseSharedAccounts(serializeSharedAccounts([A, B])), [A, B]);
});

test("a_damaged_list_reads_as_empty_and_odd_entries_are_left_out", () => {
  assert.deepEqual(parseSharedAccounts("nope"), []);
  assert.deepEqual(parseSharedAccounts(null), []);
  assert.deepEqual(parseSharedAccounts(JSON.stringify([A, { server: "http://plain.test", token: "x" }, { server: 1 }])), [A]);
});

test("an_instance_that_fails_never_hides_the_others", async () => {
  const got = await fromEvery([A, B], async (account) => {
    if (account === A) throw new Error("down");
    return 2;
  });
  assert.deepEqual(got, [{ account: B, value: 2 }]);
});
