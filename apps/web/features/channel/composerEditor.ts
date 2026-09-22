"use client";

import { emojiCode } from "@/lib/emojiCode";
import type { EmojiManifest } from "../app/emojiManifest";

const EMOJI_PX = 20;

/**
 * DOM helpers for the contenteditable composer. The editor is uncontrolled (the browser owns the
 * DOM); these functions build emote chips, serialise the editor back to a plain string (emotes become
 * their Unicode glyph, so `onSend` still receives normal text that `richText` renders as Fluent), and
 * read the caret position within that serialised text for `@`/`:` autocomplete detection.
 */

/**
 * A non-editable inline node that renders `glyph` as a Fluent emote (static sprite) or the native
 * glyph, tagged with `data-emoji` so serialisation can turn it back into text. Animation is reserved
 * for reactions, so the composer always uses the static sprite.
 */
export function emojiNode(glyph: string, manifest: EmojiManifest | null): HTMLSpanElement {
  const span = document.createElement("span");
  span.contentEditable = "false";
  span.dataset.emoji = glyph;
  span.setAttribute("role", "img");
  span.setAttribute("aria-label", glyph);
  span.style.display = "inline-block";
  span.style.verticalAlign = "middle";
  const code = emojiCode(glyph);
  if (manifest?.static.has(code)) {
    span.style.lineHeight = "0";
    // Fixed template with a hex/hyphen-only code: no user text reaches innerHTML.
    span.innerHTML = `<svg class="wc-emoji" width="${EMOJI_PX}" height="${EMOJI_PX}" aria-hidden="true"><use href="/emoji/sprite.svg#e${code}"></use></svg>`;
  } else {
    span.style.lineHeight = "1";
    span.style.fontSize = `${EMOJI_PX}px`;
    span.textContent = glyph;
  }
  return span;
}

/** Serialise the editor subtree to plain text: emotes -> glyph, `<br>`/blocks -> newline. */
export function serialize(root: Node): string {
  let out = "";
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent ?? "";
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const el = child as HTMLElement;
      if (el.dataset.emoji) {
        out += el.dataset.emoji;
        return;
      }
      if (el.tagName === "BR") {
        out += "\n";
        return;
      }
      const isBlock = el.tagName === "DIV" || el.tagName === "P";
      if (isBlock && out.length > 0 && !out.endsWith("\n")) out += "\n";
      walk(el);
    });
  };
  walk(root);
  return out;
}

/**
 * The serialised text and the caret offset within it. The caret is measured by serialising the range
 * from the editor start to the selection focus, which handles text and emote chips uniformly.
 */
export function editorState(root: HTMLElement): { text: string; caret: number } {
  const text = serialize(root);
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.focusNode || !root.contains(sel.focusNode)) {
    return { text, caret: text.length };
  }
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(sel.focusNode, sel.focusOffset);
  const holder = document.createElement("div");
  holder.appendChild(pre.cloneContents());
  return { text, caret: serialize(holder).length };
}

/** Insert `str` at the current selection, mapping newlines to `<br>`, then place the caret after it. */
export function insertTextAtSelection(str: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const frag = document.createDocumentFragment();
  str.split("\n").forEach((line, i) => {
    if (i > 0) frag.appendChild(document.createElement("br"));
    if (line) frag.appendChild(document.createTextNode(line));
  });
  const last = frag.lastChild;
  range.insertNode(frag);
  if (last) {
    const after = document.createRange();
    after.setStartAfter(last);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
  }
}

/**
 * Insert `str` at the selection as a single text node, caret `fromEnd` characters before its end.
 *
 * The editor is `white-space: pre-wrap`, so newlines inside one text node render as line breaks
 * exactly like the `<br>`s `insertTextAtSelection` builds, and `serialize` reads them back the same
 * way. Keeping the run in one node is what makes the caret placement possible: a fenced code block
 * opens with the caret on the empty line between its fences, ready to be typed into, which three
 * nodes and a `<br>` cannot express as an offset.
 */
export function insertBlockAtSelection(str: string, fromEnd = 0): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(str);
  range.insertNode(node);
  const caret = document.createRange();
  caret.setStart(node, Math.max(0, str.length - fromEnd));
  caret.collapse(true);
  sel.removeAllRanges();
  sel.addRange(caret);
}

/** Insert a DOM node at the selection (optionally with a trailing space), caret after it. */
export function insertNodeAtSelection(node: Node, trailingSpace = false): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(node);
  let after: Node = node;
  if (trailingSpace) {
    const space = document.createTextNode(" ");
    node.parentNode?.insertBefore(space, node.nextSibling);
    after = space;
  }
  const caret = document.createRange();
  caret.setStartAfter(after);
  caret.collapse(true);
  sel.removeAllRanges();
  sel.addRange(caret);
}

/**
 * Replace the `length` characters ending at the caret (an `@mention` or `:shortcode` token the user
 * just typed) with `node`. The token is contiguous typed text, so it lives in the focus text node.
 */
export function replaceTokenBeforeCaret(length: number, node: Node, trailingSpace = false): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const focus = sel.focusNode;
  const offset = sel.focusOffset;
  const range = document.createRange();
  if (focus && focus.nodeType === Node.TEXT_NODE && offset >= length) {
    range.setStart(focus, offset - length);
    range.setEnd(focus, offset);
    range.deleteContents();
  } else {
    // Fallback: no clean token span, just insert at the caret.
    range.setStart(focus ?? sel.getRangeAt(0).startContainer, offset);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
  insertNodeAtSelection(node, trailingSpace);
}
