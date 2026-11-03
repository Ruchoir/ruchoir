/**
 * The style of a row of the sidebar, reading the style tokens (see the design system's
 * `tokens.css`): kept out of the component so a test can hold it to them.
 */

import type { CSSProperties } from "react";

/** A row of the sidebar, selected or not. */
export function sideItemStyle(on: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    height: 34,
    padding: "0 8px",
    border: 0,
    borderRadius: "var(--radius-item)",
    background: on ? "var(--sidebar-selected-bg)" : "transparent",
    // A style may mark the selected row with a bar at its start; the Ruchoir style draws none.
    boxShadow: on ? "var(--sidebar-selected-mark)" : undefined,
    // The active row is filled with the theme's pastel, and a pastel always carries the dark ink.
    color: on ? "var(--sidebar-selected-fg)" : "var(--text-body)",
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    fontWeight: on ? 600 : 400,
    textAlign: "left",
    transition: "background-color var(--duration-fast) var(--ease-out)",
  };
}
