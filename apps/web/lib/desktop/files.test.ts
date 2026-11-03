import { test } from "node:test";
import assert from "node:assert/strict";

import { openTarget } from "./files.ts";

test("a_relative_address_becomes_the_apps_absolute_one_with_path_and_query", () => {
  const href = openTarget("/i/ab12/api/v1/files/f1/preview?v=3", "http://ruchoir.localhost/");
  assert.equal(href, "http://ruchoir.localhost/i/ab12/api/v1/files/f1/preview?v=3");
});

test("an_absolute_address_is_kept_as_it_is", () => {
  const href = "http://ruchoir.localhost/i/ab12/api/v1/files/f1/preview";
  assert.equal(openTarget(href, "http://ruchoir.localhost/"), href);
});
