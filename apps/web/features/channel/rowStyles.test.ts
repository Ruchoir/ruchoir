import assert from "node:assert/strict";
import { test } from "node:test";
import { composerShellStyle, msgRowPadding, msgRowStyle } from "./rowStyles.ts";

test("a message row spaces its avatar with the density token", () => {
  assert.equal(msgRowStyle.gap, "var(--msg-gap)");
});

test("a message row's padding reads the density tokens and keeps the receipt's reserve", () => {
  assert.equal(msgRowPadding(false, true), "var(--msg-pad-top) var(--msg-pad-x) 18px");
  assert.equal(msgRowPadding(true, false), "var(--msg-pad-top-grouped) var(--msg-pad-x) 4px");
});

test("the composer sits on the editing offset while a message is corrected", () => {
  assert.equal(composerShellStyle(true, false).boxShadow, "var(--shadow-editing)");
  assert.equal(composerShellStyle(true, true).boxShadow, "var(--shadow-editing)");
});

test("files held over the composer fill it with the selection, and nothing else does", () => {
  assert.equal(composerShellStyle(false, true).background, "var(--surface-selected)");
  assert.deepEqual(composerShellStyle(false, false), {});
});
