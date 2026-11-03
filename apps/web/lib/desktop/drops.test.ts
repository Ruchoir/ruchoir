import { test } from "node:test";
import assert from "node:assert/strict";

import { cancelStrayDrop, strayFileDrop } from "./drops.ts";

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

test("a_stray_dragover_is_cancelled_and_shows_no_drop_cursor", () => {
  let prevented = false;
  const dataTransfer = { types: ["Files"], dropEffect: "copy" };
  cancelStrayDrop({ type: "dragover", defaultPrevented: false, dataTransfer, preventDefault: () => (prevented = true) } as unknown as DragEvent);
  assert.equal(prevented, true);
  assert.equal(dataTransfer.dropEffect, "none");
});

test("a_dragover_a_handler_took_keeps_its_drop_effect", () => {
  let prevented = false;
  const dataTransfer = { types: ["Files"], dropEffect: "copy" };
  cancelStrayDrop({ type: "dragover", defaultPrevented: true, dataTransfer, preventDefault: () => (prevented = true) } as unknown as DragEvent);
  assert.equal(prevented, false);
  assert.equal(dataTransfer.dropEffect, "copy");
});
