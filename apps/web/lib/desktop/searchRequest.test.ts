import { test } from "node:test";
import assert from "node:assert/strict";

import { onSearchRequest, requestSearch } from "./searchRequest.ts";

test("a_request_reaches_every_listener_until_it_stops", () => {
  let heard = 0;
  const stop = onSearchRequest(() => (heard += 1));
  requestSearch();
  assert.equal(heard, 1);
  stop();
  requestSearch();
  assert.equal(heard, 1);
});
