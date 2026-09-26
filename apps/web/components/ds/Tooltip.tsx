"use client";

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { uiZoom } from "./uiZoom";

export type TooltipSide = "top" | "bottom" | "left" | "right";

export type TooltipProps = {
  label: ReactNode;
  shortcut?: string;
  side?: TooltipSide;
  children: ReactNode;
  className?: string;
};

type Coords = { top: number; left: number };

const MARGIN = 8;
const GAP = 6;

type RectLike = { top: number; bottom: number; left: number; right: number; width: number; height: number };

function place(side: TooltipSide, a: RectLike, w: number, h: number, vw: number, vh: number): Coords {
  const cx = a.left + a.width / 2;
  const cy = a.top + a.height / 2;
  let top = 0;
  let left = 0;
  let s = side;
  // Flip to the opposite side when there is no room.
  if (s === "top" && a.top - h - GAP < MARGIN) s = "bottom";
  else if (s === "bottom" && a.bottom + h + GAP > vh - MARGIN) s = "top";
  else if (s === "left" && a.left - w - GAP < MARGIN) s = "right";
  else if (s === "right" && a.right + w + GAP > vw - MARGIN) s = "left";

  if (s === "top") {
    top = a.top - h - GAP;
    left = cx - w / 2;
  } else if (s === "bottom") {
    top = a.bottom + GAP;
    left = cx - w / 2;
  } else if (s === "left") {
    top = cy - h / 2;
    left = a.left - w - GAP;
  } else {
    top = cy - h / 2;
    left = a.right + GAP;
  }
  top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN));
  left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
  return { top, left };
}

const bubble: CSSProperties = {
  position: "fixed",
  zIndex: 90,
  pointerEvents: "none",
  display: "inline-flex",
  alignItems: "center",
  background: "var(--surface-inverse)",
  color: "var(--text-inverse)",
  // Set like every label: the monospace face, in sentence case.
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1.3,
  padding: "5px var(--space-2)",
  borderRadius: "var(--radius-sm)",
  whiteSpace: "nowrap",
};

/** Dark hover tooltip, portaled and viewport-aware (flips/clamps so it never overflows). */
export function Tooltip({ label, shortcut, side = "top", children, className = "" }: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Coords | null>(null);

  useEffect(() => {
    if (!open) return;
    const compute = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const b = bubbleRef.current?.getBoundingClientRect();
      if (!a) return;
      // Convert visual rects and the viewport to unzoomed layout space so the fixed bubble lands right
      // under the text-size zoom (see uiZoom). A no-op at the default zoom of 1.
      const z = uiZoom();
      const anchor: RectLike = { top: a.top / z, bottom: a.bottom / z, left: a.left / z, right: a.right / z, width: a.width / z, height: a.height / z };
      setPos(place(side, anchor, (b?.width ?? 80) / z, (b?.height ?? 24) / z, window.innerWidth / z, window.innerHeight / z));
    };
    compute();
    // Leaving the tab or the window closes it: nothing is hovered any more, and the focus the
    // browser hands back on return must not reopen it (see `onFocus`).
    const close = () => setOpen(false);
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    window.addEventListener("blur", close);
    document.addEventListener("visibilitychange", close);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
      window.removeEventListener("blur", close);
      document.removeEventListener("visibilitychange", close);
      // Reset in cleanup (a callback, not a synchronous effect-body setState) so the next open recomputes.
      setPos(null);
    };
  }, [open, side]);

  return (
    <span
      ref={anchorRef}
      className={className}
      style={{ display: "inline-flex" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      // Only a keyboard focus opens it. A click also focuses the control, and coming back to the tab
      // hands that focus back to it: opening on any focus left the tooltip of the last clicked control
      // (the current space, typically) standing with the pointer nowhere near it.
      onFocus={(e) => {
        if (e.target instanceof Element && e.target.matches(":focus-visible")) setOpen(true);
      }}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={bubbleRef}
              role="tooltip"
              className="wc-pop"
              style={{ ...bubble, top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
            >
              {label}
              {shortcut ? (
                <span style={{ marginLeft: "var(--space-2)", color: "color-mix(in srgb, var(--text-inverse) 65%, var(--surface-inverse))", fontFamily: "var(--font-mono)" }}>
                  {shortcut}
                </span>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
