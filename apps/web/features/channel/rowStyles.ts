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
  margin: "0 -8px",
  borderRadius: "var(--radius-md)",
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
 * The composer's box while a message is corrected (on the editing offset, the colour of a change
 * under way) or while files are held over it (filled with the selection).
 */
export function composerShellStyle(editing: boolean, dragging: boolean): CSSProperties {
  if (editing) return { boxShadow: "var(--shadow-editing)" };
  if (dragging) return { background: "var(--surface-selected)" };
  return {};
}
