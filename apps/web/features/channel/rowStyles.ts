/**
 * The styles of a message row and of the composer's box that read the style tokens (see the
 * design system's `tokens.css`): kept out of the components so a test can hold them to the tokens.
 */

import type { CSSProperties } from "react";

/** A message row: the avatar and the text side by side, at the density the style sets. */
export const msgRowStyle: CSSProperties = {
  display: "flex",
  gap: "var(--msg-gap)",
  // Bottom padding reserves room for the hover read receipt so it never overlaps content.
  padding: "var(--msg-pad-top) var(--msg-pad-x) 18px",
  // A style that draws messages as cards gives them an edge and room under each; Ruchoir none.
  border: "var(--msg-edge)",
  margin: "0 -8px var(--msg-space)",
  borderRadius: "var(--radius-msg)",
  position: "relative",
  transition: "background-color var(--duration-fast) var(--ease-out)",
};

/**
 * A row's padding. The two halves are decided separately, because they answer different questions.
 * Above: is this line continuing the one before it (`grouped`), which the style's density sets.
 * Below: is anything continuing this one (`endsRun` says nothing does), which is also what says
 * whether the hover receipt needs room: 18px is that reserve, not density, so no style changes it.
 */
export function msgRowPadding(grouped: boolean, endsRun: boolean): string {
  return `${grouped ? "var(--msg-pad-top-grouped)" : "var(--msg-pad-top)"} var(--msg-pad-x) ${endsRun ? "18px" : "4px"}`;
}

/**
 * A row's fill. A deleted message is never lit; then, in this order, the actions sheet open on it,
 * the pointer over it, a mention of the reader (washed in the theme's pastel, the colour that means
 * "yours"), and at rest the style's card (transparent in the Ruchoir style).
 */
export function msgRowBackground(state: { deleted: boolean; sheetOpen: boolean; hover: boolean; mentionsMe: boolean }): string {
  if (state.deleted) return "transparent";
  if (state.sheetOpen) return "var(--surface-selected)";
  if (state.hover) return "var(--surface-hover)";
  if (state.mentionsMe) return "var(--surface-mention)";
  return "var(--msg-bg)";
}

/**
 * The composer's box while a message is corrected (on the editing offset, the colour of a change
 * under way) or while files are held over it (filled with the selection).
 */
export function composerShellStyle(editing: boolean, dragging: boolean): CSSProperties {
  if (editing) return { boxShadow: "var(--shadow-editing)" };
  if (dragging) return { background: "var(--surface-selected)" };
  return {};
}
