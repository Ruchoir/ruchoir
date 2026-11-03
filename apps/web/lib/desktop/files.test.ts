import { test } from "node:test";
import assert from "node:assert/strict";

import { FILE_ERROR_EVENT, listenFileErrors, openTarget } from "./files.ts";

test("a_relative_address_becomes_the_apps_absolute_one_with_path_and_query", () => {
  const href = openTarget("/i/ab12/api/v1/files/f1/preview?v=3", "http://ruchoir.localhost/");
  assert.equal(href, "http://ruchoir.localhost/i/ab12/api/v1/files/f1/preview?v=3");
});

test("an_absolute_address_is_kept_as_it_is", () => {
  const href = "http://ruchoir.localhost/i/ab12/api/v1/files/f1/preview";
  assert.equal(openTarget(href, "http://ruchoir.localhost/"), href);
});

test("installing_the_error_listener_twice_reports_once", () => {
  const target = new EventTarget();
  (globalThis as unknown as { window: EventTarget }).window = target;
  const seen: string[] = [];
  listenFileErrors((code) => seen.push(code));
  const stop = listenFileErrors((code) => seen.push(code));
  target.dispatchEvent(new CustomEvent(FILE_ERROR_EVENT, { detail: "file:refused" }));
  assert.deepEqual(seen, ["file:refused"]);
  stop();
  target.dispatchEvent(new CustomEvent(FILE_ERROR_EVENT, { detail: "file:failed" }));
  assert.equal(seen.length, 1);
});
