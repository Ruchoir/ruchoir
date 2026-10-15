"use client";

import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

export type DrawerProps = {
  open: boolean;
  onClose: () => void;
  /** Which edge the panel slides in from. */
  side?: "left" | "right";
  /** Panel width; capped to the viewport so it never overflows. */
  width?: number;
  label?: string;
  children: ReactNode;
};

const DURATION = 220;

/**
 * Off-canvas panel that slides in from an edge over a scrim. Closes on scrim click or Escape.
 * Self-contained enter/exit animation (no external hook) so it can live in the DS layer.
 */
export function Drawer({ open, onClose, side = "left", width = 300, label, children }: DrawerProps) {
  const [render, setRender] = useState(open);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    // `render` must persist as state through the exit window so the drawer stays mounted while it
    // slides out; setting it synchronously here is the canonical enter/exit pattern, not derivable.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (open) {
      setRender(true);
      const id = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(id);
    }
    setEntered(false);
    const t = setTimeout(() => setRender(false), DURATION);
    return () => clearTimeout(t);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!render) return null;

  const scrim: CSSProperties = {
    position: "fixed",
    // Compensated for the text-size zoom (see globals.css) so it fills the screen without overflow.
    top: 0,
    left: 0,
    width: "var(--ui-vw, 100vw)",
    height: "var(--ui-vh, 100dvh)",
    zIndex: 70,
    background: "var(--scrim, rgba(15, 23, 42, 0.45))",
    opacity: entered ? 1 : 0,
    transition: `opacity ${DURATION}ms var(--ease-out)`,
  };
  const hidden = side === "left" ? "translateX(-100%)" : "translateX(100%)";
  const panel: CSSProperties = {
    position: "fixed",
    top: 0,
    height: "var(--ui-vh, 100dvh)",
    [side]: 0,
    zIndex: 71,
    width: `min(${width}px, calc(0.88 * var(--ui-vw, 100vw)))`,
    background: "var(--surface-chrome)",
    borderRight: side === "left" ? "1px solid var(--border-subtle)" : undefined,
    borderLeft: side === "right" ? "1px solid var(--border-subtle)" : undefined,
    boxShadow: "var(--shadow-popover)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    transform: entered ? "translateX(0)" : hidden,
    transition: `transform ${DURATION}ms var(--ease-out)`,
  };

  return (
    <>
      <div style={scrim} onClick={onClose} aria-hidden />
      <aside style={panel} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </aside>
    </>
  );
}
