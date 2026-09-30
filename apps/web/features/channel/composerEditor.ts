"use client";

import { emojiCode } from "@/lib/emojiCode";
import type { EmojiManifest } from "../app/emojiManifest";

const EMOJI_PX = 20;
const TRAILING_BREAK_ATTRIBUTE = "data-composer-trailing-break";

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

/** The state of one walk over the editor: the text so far, and where the caret turned up in it. */
type Walk = {
  out: string;
  focus: Node | null;
  focusOffset: number;
  caret: number;
  /** Inside a table cell, where a line break is a space and a bar would split the cell. */
  cell: boolean;
};

/** Marks the box that holds a table, so serialising can tell it from ordinary text. */
const TABLE_ATTRIBUTE = "data-composer-table";
/** Marks what the editor draws around a table (its buttons), which is never part of the message. */
const UI_ATTRIBUTE = "data-composer-ui";

function walkChildren(parent: Node, w: Walk): void {
  for (let i = 0; i <= parent.childNodes.length; i++) {
    if (w.caret < 0 && parent === w.focus && w.focusOffset === i) w.caret = w.out.length;
    const child = parent.childNodes[i];
    if (!child) break;
    if (child.nodeType === Node.TEXT_NODE) {
      if (w.caret < 0 && child === w.focus) w.caret = w.out.length + w.focusOffset;
      const text = child.textContent ?? "";
      w.out += w.cell ? text.replace(/[\r\n]/g, " ").replace(/\|/g, "¦") : text;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    // A contenteditable needs a second terminal break to render the caret on the new line. It is
    // layout scaffolding, not another line in the message.
    if (el.hasAttribute(TRAILING_BREAK_ATTRIBUTE) || el.hasAttribute(UI_ATTRIBUTE)) continue;
    if (el.dataset.emoji) {
      w.out += el.dataset.emoji;
      continue;
    }
    if (el.tagName === "BR") {
      w.out += w.cell ? " " : "\n";
      continue;
    }
    if (el.hasAttribute(TABLE_ATTRIBUTE)) {
      walkTable(el, w);
      continue;
    }
    const isBlock = el.tagName === "DIV" || el.tagName === "P";
    if (isBlock && !w.cell && w.out.length > 0 && !w.out.endsWith("\n")) w.out += "\n";
    walkChildren(el, w);
  }
}

/**
 * A table drawn in the editor, written as the pipe table the message reader draws: the header row,
 * the dashed row, then the rows, each on a line of its own and the whole on lines of its own.
 */
function walkTable(box: HTMLElement, w: Walk): void {
  const table = box.querySelector("table");
  if (!table) return;
  if (w.out.length > 0 && !w.out.endsWith("\n")) w.out += "\n";
  const rows = Array.from(table.rows);
  const width = Math.max(1, ...rows.map((row) => row.cells.length));
  rows.forEach((row, r) => {
    w.out += "|";
    for (let c = 0; c < width; c++) {
      w.out += " ";
      const cell = row.cells[c];
      if (cell) {
        const start = w.out.length;
        w.cell = true;
        walkChildren(cell, w);
        w.cell = false;
        // A cell keeps a line break of its own while empty (so it can take a caret): not content.
        while (w.out.length > start && w.out.endsWith(" ")) w.out = w.out.slice(0, -1);
        if (w.caret >= start && w.caret > w.out.length) w.caret = w.out.length;
      }
      w.out += " |";
    }
    w.out += "\n";
    if (r === 0) w.out += `|${" --- |".repeat(width)}\n`;
  });
}

/** Serialise the editor subtree to plain text: emotes -> glyph, `<br>`/blocks -> newline, a table -> a pipe table. */
export function serialize(root: Node): string {
  const w: Walk = { out: "", focus: null, focusOffset: 0, caret: -1, cell: false };
  walkChildren(root, w);
  return w.out;
}

/**
 * The serialised text and the caret offset within it, found while writing the text out, so that a
 * caret inside a table cell lands where that cell is in the text, and emote chips count as their glyph.
 */
export function editorState(root: HTMLElement): { text: string; caret: number } {
  const sel = window.getSelection();
  const inside = !!sel && sel.rangeCount > 0 && !!sel.focusNode && root.contains(sel.focusNode);
  const w: Walk = {
    out: "",
    focus: inside ? sel.focusNode : null,
    focusOffset: inside ? sel.focusOffset : 0,
    caret: -1,
    cell: false,
  };
  walkChildren(root, w);
  return { text: w.out, caret: w.caret >= 0 ? w.caret : w.out.length };
}

/**
 * Markdown block prefix to carry onto the next line at `caret`.
 *
 * Only structures whose meaning spans several lines continue here. Headings deliberately do not:
 * a heading labels the text that follows it, while a list, checklist or quotation is commonly
 * written one line at a time. A completed checklist item always opens an unchecked item next.
 */
export function continuedLinePrefix(text: string, caret: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const line = text.slice(lineStart, caret);

  const task = /^(\s*[-*] \[)[ xX](\] )/.exec(line);
  if (task) return `${task[1]} ${task[2]}`;

  const ordered = /^(\s*)(\d{1,9})([.)] )/.exec(line);
  if (ordered) return `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]}`;

  const bullet = /^(\s*[-*] )/.exec(line);
  if (bullet) return bullet[1];

  const quote = /^(\s*(?:> ?)+)/.exec(line);
  return quote?.[1] ?? "";
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

/** Insert a soft line break and keep the caret visible when that break ends the editor. */
export function insertLineBreakAtSelection(root: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;

  // Chromium renders a caret after a lone terminal <br> at the beginning of the preceding line.
  // A second, non-serialised <br> gives that caret a real visual line to occupy.
  const tail = document.createRange();
  tail.selectNodeContents(root);
  tail.setStart(range.endContainer, range.endOffset);
  const holder = document.createElement("div");
  holder.appendChild(tail.cloneContents());
  const atEnd = serialize(holder) === "";

  range.deleteContents();
  const lineBreak = document.createElement("br");
  range.insertNode(lineBreak);

  if (atEnd && !root.querySelector(`[${TRAILING_BREAK_ATTRIBUTE}]`)) {
    const trailingBreak = document.createElement("br");
    trailingBreak.setAttribute(TRAILING_BREAK_ATTRIBUTE, "");
    lineBreak.parentNode?.insertBefore(trailingBreak, lineBreak.nextSibling);
  }

  const caret = document.createRange();
  caret.setStartAfter(lineBreak);
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

// -- tables ----------------------------------------------------------------------------------------

export type TableLabels = { addRow: string; addColumn: string; remove: string };

const MAX_COLUMNS = 8;
const MAX_ROWS = 30;

function styleCell(cell: HTMLElement, header: boolean): void {
  Object.assign(cell.style, {
    border: "1px solid var(--border-default)",
    padding: "5px 10px",
    minWidth: "72px",
    textAlign: "left",
    verticalAlign: "top",
    fontWeight: header ? "600" : "400",
    background: header ? "var(--surface-hover)" : "transparent",
    color: header ? "var(--text-strong)" : "var(--text-body)",
  });
}

function makeCell(header: boolean, text: string): HTMLTableCellElement {
  const cell = document.createElement(header ? "th" : "td");
  styleCell(cell, header);
  if (text) cell.textContent = text;
  // An empty cell needs something to hold a caret.
  else cell.appendChild(document.createElement("br"));
  return cell;
}

function makeRow(columns: number, header = false): HTMLTableRowElement {
  const row = document.createElement("tr");
  for (let c = 0; c < columns; c++) row.appendChild(makeCell(header, ""));
  return row;
}

/**
 * A table as the composer draws it: real cells to fill in, styled, with three small buttons under
 * it. `rows` is the header row then the body rows. The box is not editable and the table inside it
 * is, so the caret stays in the cells; `onChange` is called after the buttons change the table, since
 * the browser raises no input event for what they do.
 */
export function tableNode(rows: string[][], labels: TableLabels, onChange: () => void): HTMLElement {
  const box = document.createElement("div");
  box.setAttribute(TABLE_ATTRIBUTE, "");
  box.contentEditable = "false";
  Object.assign(box.style, { display: "block", margin: "6px 0", maxWidth: "100%", overflowX: "auto" });

  const table = document.createElement("table");
  table.contentEditable = "true";
  Object.assign(table.style, { borderCollapse: "collapse", fontSize: "inherit", whiteSpace: "pre-wrap" });
  const head = document.createElement("thead");
  const body = document.createElement("tbody");
  rows.forEach((cells, r) => {
    const row = document.createElement("tr");
    cells.forEach((text) => row.appendChild(makeCell(r === 0, text)));
    (r === 0 ? head : body).appendChild(row);
  });
  table.append(head, body);

  const bar = document.createElement("div");
  bar.setAttribute(UI_ATTRIBUTE, "");
  Object.assign(bar.style, { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px" });
  const button = (label: string, action: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    Object.assign(b.style, {
      font: "inherit",
      fontSize: "var(--text-2xs)",
      padding: "2px 8px",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--radius-sm)",
      background: "var(--surface-raised)",
      color: "var(--text-muted)",
      cursor: "pointer",
    });
    // The click must not take the caret out of the table.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      action();
      onChange();
    });
    bar.appendChild(b);
  };
  button(labels.addRow, () => {
    if (table.rows.length <= MAX_ROWS) body.appendChild(makeRow(table.rows[0]?.cells.length ?? 1));
  });
  button(labels.addColumn, () => addColumn(table));
  button(labels.remove, () => box.remove());

  box.append(table, bar);
  return box;
}

function addColumn(table: HTMLTableElement): void {
  if ((table.rows[0]?.cells.length ?? 0) >= MAX_COLUMNS) return;
  Array.from(table.rows).forEach((row, r) => row.appendChild(makeCell(r === 0, "")));
}

/** The table cell the caret is in, or null. */
export function cellAtCaret(root: HTMLElement): HTMLTableCellElement | null {
  const node = window.getSelection()?.focusNode;
  if (!node || !root.contains(node)) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const cell = el?.closest("td, th");
  return cell && root.contains(cell) && cell.closest(`[${TABLE_ATTRIBUTE}]`) ? (cell as HTMLTableCellElement) : null;
}

/** Put the caret in a cell, with its words selected so that typing replaces them. */
export function selectCell(cell: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  if ((cell.textContent ?? "").trim() === "") {
    range.setStart(cell, 0);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Tab (forward) or Shift+Tab (back) from a cell: the next cell, a new row past the last one. */
export function moveCell(cell: HTMLTableCellElement, forward: boolean): void {
  const table = cell.closest("table");
  if (!table) return;
  const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>("th, td"));
  const at = cells.indexOf(cell);
  const target = at + (forward ? 1 : -1);
  if (target >= 0 && target < cells.length) return selectCell(cells[target]);
  if (forward && table.rows.length < MAX_ROWS) {
    const row = makeRow(table.rows[0].cells.length);
    (table.tBodies[0] ?? table.appendChild(document.createElement("tbody"))).appendChild(row);
    selectCell(row.cells[0]);
  }
}

/** A new row under the one the caret is in (under the header, when that is the row), caret in the same column. */
export function addRowBelow(cell: HTMLTableCellElement): void {
  const table = cell.closest("table");
  const row = cell.parentElement as HTMLTableRowElement | null;
  if (!table || !row || table.rows.length >= MAX_ROWS) return;
  const fresh = makeRow(row.cells.length);
  const body = table.tBodies[0] ?? table.appendChild(document.createElement("tbody"));
  if (row.parentElement === table.tHead) body.insertBefore(fresh, body.firstChild);
  else row.after(fresh);
  selectCell(fresh.cells[Math.min(cell.cellIndex, fresh.cells.length - 1)]);
}

/**
 * Pour a grid of text into the table from the cell the caret is in, growing the table to hold it.
 * What a spreadsheet copies, pasted into the table that is being written.
 */
export function fillFrom(cell: HTMLTableCellElement, grid: string[][]): void {
  const table = cell.closest("table");
  const row = cell.parentElement as HTMLTableRowElement | null;
  if (!table || !row) return;
  const body = table.tBodies[0] ?? table.appendChild(document.createElement("tbody"));
  const startRow = row.rowIndex;
  const startCol = cell.cellIndex;
  const width = Math.min(MAX_COLUMNS, Math.max(table.rows[0].cells.length, startCol + Math.max(...grid.map((line) => line.length))));
  while (table.rows[0].cells.length < width) addColumn(table);
  const height = Math.min(MAX_ROWS, Math.max(table.rows.length, startRow + grid.length));
  while (table.rows.length < height) body.appendChild(makeRow(width));
  grid.forEach((line, i) =>
    line.forEach((text, j) => {
      const target = table.rows[startRow + i]?.cells[startCol + j];
      if (!target || startCol + j >= width) return;
      target.textContent = text.trim();
      if (!target.textContent) target.appendChild(document.createElement("br"));
    }),
  );
}

/** Whether the node sits inside a table box. */
export function tableBoxOf(node: Node | null, root: HTMLElement): HTMLElement | null {
  const el = node && (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement);
  const box = el?.closest<HTMLElement>(`[${TABLE_ATTRIBUTE}]`) ?? null;
  return box && root.contains(box) ? box : null;
}

/** Insert a table node at the caret, after the table the caret is in when it is in one, and keep a line after it. */
export function insertTableAtCaret(root: HTMLElement, node: HTMLElement): void {
  const sel = window.getSelection();
  let range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (!range || !root.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(root);
  }
  const inside = tableBoxOf(range.endContainer, root);
  if (inside) {
    range = document.createRange();
    range.setStartAfter(inside);
  } else {
    // Beside what is selected, never over it: the words are somebody's.
    range.collapse(false);
  }
  range.collapse(true);
  range.insertNode(node);
  if (!node.nextSibling) {
    const tail = document.createElement("br");
    tail.setAttribute(TRAILING_BREAK_ATTRIBUTE, "");
    node.after(tail);
  }
}

/** Replace the editor's content with a body, its pipe tables drawn as tables. */
export function loadBody(
  root: HTMLElement,
  segments: ({ kind: "text"; text: string } | { kind: "table"; rows: string[][] })[],
  labels: TableLabels,
  onChange: () => void,
): void {
  root.innerHTML = "";
  for (const segment of segments) {
    if (segment.kind === "text") root.append(document.createTextNode(segment.text));
    else root.append(tableNode(segment.rows, labels, onChange));
  }
  if (root.lastChild && (root.lastChild as HTMLElement).hasAttribute?.(TABLE_ATTRIBUTE)) {
    const tail = document.createElement("br");
    tail.setAttribute(TRAILING_BREAK_ATTRIBUTE, "");
    root.append(tail);
  }
}
