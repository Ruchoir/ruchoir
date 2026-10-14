import { test } from "node:test";
import assert from "node:assert/strict";

import { splitBySize } from "../src/logic/attachments.ts";

const f = (name: string, size?: number) => ({ name, size });

test("a_file_over_the_limit_is_refused_by_name", () => {
  const { accepted, refused } = splitBySize([f("a.jpg", 10), f("film.mov", 500), f("b.pdf", 100)], 100);
  assert.deepEqual(accepted.map((x) => x.name), ["a.jpg", "b.pdf"]);
  assert.deepEqual(refused.map((x) => x.name), ["film.mov"]);
});

test("an_unknown_limit_or_size_lets_the_server_decide", () => {
  assert.equal(splitBySize([f("a", 500)], undefined).refused.length, 0);
  assert.equal(splitBySize([f("a")], 100).refused.length, 0);
});
