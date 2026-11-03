import assert from "node:assert/strict";
import { test } from "node:test";
import { composerShellStyle, msgRowBackground, msgRowPadding, msgRowStyle } from "./rowStyles.ts";

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

test("a message row can be a card: its edge, its corners and its distance to the next read tokens", () => {
  assert.equal(msgRowStyle.border, "var(--msg-edge)");
  assert.equal(msgRowStyle.margin, "0 -8px var(--msg-space)");
  assert.equal(msgRowStyle.borderRadius, "var(--radius-msg)");
});

test("a message row's background: deleted, then the open sheet, the pointer, a mention, else the style's card", () => {
  const at = { deleted: false, sheetOpen: false, hover: false, mentionsMe: false };
  assert.equal(msgRowBackground(at), "var(--msg-bg)");
  assert.equal(msgRowBackground({ ...at, mentionsMe: true }), "var(--surface-mention)");
  assert.equal(msgRowBackground({ ...at, mentionsMe: true, hover: true }), "var(--surface-hover)");
  assert.equal(msgRowBackground({ ...at, hover: true, sheetOpen: true }), "var(--surface-selected)");
  assert.equal(msgRowBackground({ deleted: true, sheetOpen: true, hover: true, mentionsMe: true }), "transparent");
});
