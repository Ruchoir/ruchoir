import { test } from "node:test";
import assert from "node:assert/strict";

import { strayFileDrop } from "./drops.ts";

const event = (defaultPrevented: boolean, types: string[] | null) =>
  ({ defaultPrevented, dataTransfer: types ? { types } : null }) as unknown as Pick<DragEvent, "defaultPrevented" | "dataTransfer">;

test("a_file_drop_nobody_took_is_stray", () => {
  assert.equal(strayFileDrop(event(false, ["Files"])), true);
});

test("a_drop_a_handler_took_is_left_alone", () => {
  assert.equal(strayFileDrop(event(true, ["Files"])), false);
});

test("text_and_links_are_not_files", () => {
  assert.equal(strayFileDrop(event(false, ["text/plain", "text/uri-list"])), false);
  assert.equal(strayFileDrop(event(false, null)), false);
});
