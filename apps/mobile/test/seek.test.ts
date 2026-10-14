import { test } from "node:test";
import assert from "node:assert/strict";

import { seekMessage } from "../src/logic/seek.ts";

type M = { id: string };

/** A history of `pages`, newest first, each one pointing at the next by its index. */
function history(pages: M[][]) {
  const asked: string[] = [];
  const fetchPage = async (before: string) => {
    asked.push(before);
    const i = Number(before);
    return { messages: pages[i], nextBefore: i + 1 < pages.length ? String(i + 1) : undefined };
  };
  return { fetchPage, asked };
}

test("a_message_further_up_is_found_page_after_page", async () => {
  const { fetchPage, asked } = history([[{ id: "a" }], [{ id: "b" }, { id: "pinned" }], [{ id: "c" }]]);
  const found = await seekMessage(fetchPage, "0", "pinned");
  assert.equal(found.found, true);
  assert.deepEqual(found.messages.map((m) => m.id), ["a", "b", "pinned"]);
  assert.equal(found.nextBefore, "2");
  assert.deepEqual(asked, ["0", "1"]);
});

test("the_beginning_of_the_conversation_ends_the_search", async () => {
  const { fetchPage } = history([[{ id: "a" }], [{ id: "b" }]]);
  const found = await seekMessage(fetchPage, "0", "gone");
  assert.equal(found.found, false);
  assert.deepEqual(found.messages.map((m) => m.id), ["a", "b"]);
  assert.equal(found.nextBefore, "");
});

test("nothing_older_means_nothing_to_fetch", async () => {
  const { fetchPage, asked } = history([[{ id: "a" }]]);
  for (const before of [undefined, ""]) {
    const found = await seekMessage(fetchPage, before, "x");
    assert.equal(found.found, false);
    assert.equal(found.nextBefore, "");
  }
  assert.deepEqual(asked, []);
});

test("the_search_stops_after_a_few_pages", async () => {
  const pages = Array.from({ length: 50 }, (_, i) => [{ id: `m${i}` }]);
  const { fetchPage, asked } = history(pages);
  const found = await seekMessage(fetchPage, "0", "never", 3);
  assert.equal(found.found, false);
  assert.equal(asked.length, 3);
  // Where it stopped, so scrolling up carries on from there.
  assert.equal(found.nextBefore, "3");
});
