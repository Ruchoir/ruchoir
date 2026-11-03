import assert from "node:assert/strict";
import { test } from "node:test";
import { sideItemStyle } from "./sidebarStyles.ts";

test("the selected sidebar row carries the style's mark, the others none", () => {
  assert.equal(sideItemStyle(true).boxShadow, "var(--sidebar-selected-mark)");
  assert.equal(sideItemStyle(false).boxShadow, undefined);
});

test("a sidebar row's corners and fill read the style tokens", () => {
  assert.equal(sideItemStyle(true).borderRadius, "var(--radius-item)");
  assert.equal(sideItemStyle(false).borderRadius, "var(--radius-item)");
  assert.equal(sideItemStyle(true).background, "var(--sidebar-selected-bg)");
  assert.equal(sideItemStyle(false).background, "transparent");
});
