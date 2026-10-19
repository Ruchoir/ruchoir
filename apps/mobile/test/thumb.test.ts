import { test } from "node:test";
import assert from "node:assert/strict";
import { thumbBox } from "../src/logic/thumb.ts";

test("thumb_box_keeps_the_whole_picture", () => {
  // A landscape photo in a wide pane: capped at 300 wide, proportions kept.
  assert.deepEqual(thumbBox(700, 4032, 3024), { width: 300, height: 225 });
  // A narrow column: the column's width.
  assert.deepEqual(thumbBox(200, 4032, 3024), { width: 200, height: 150 });
  // A portrait photo: capped in height, so narrower.
  assert.deepEqual(thumbBox(700, 3024, 4032), { width: 240, height: 320 });
  // Unknown size: 4:3.
  assert.deepEqual(thumbBox(700, undefined, undefined), { width: 300, height: 225 });
  // Before the column is measured.
  assert.deepEqual(thumbBox(0, 10, 10), { width: 0, height: 0 });
});
