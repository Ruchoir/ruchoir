"use client";

import { type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef } from "react";
import { Icon, Popover } from "@/components/ds";

const menu: CSSProperties = {
  minWidth: 224,
  maxWidth: 280,
  padding: 4,
  background: "var(--surface-raised)",
  border: "2px solid var(--ink)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-popover)",
};

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 8px",
  border: 0,
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--text-body)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  textAlign: "left",
  cursor: "pointer",
};

export type MenuItem =
  | { type?: "item"; icon?: string; label: ReactNode; onClick: () => void; danger?: boolean; active?: boolean }
  | { type: "separator" }
  | { type: "label"; label: string };

export type MenuPopoverProps = {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  items: MenuItem[];
  placement?: "top" | "bottom";
  align?: "start" | "end";
  /** A point to open at instead of the anchor's box (a right-click opens where the pointer is). */
  getAnchorRect?: () => DOMRect | null;
  /** Accessible name of the menu. */
  label?: string;
};

/** The menu's buttons, in order. */
function itemsOf(menuEl: HTMLElement | null): HTMLButtonElement[] {
  return menuEl ? Array.from(menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) : [];
}

/**
 * A dropdown menu rendered in a viewport-aware popover.
 *
 * Driven from the keyboard as a menu is expected to be: the first item takes the focus on opening,
 * the arrows (and Home, End) move between items, Tab and Escape close it, and the focus goes back to
 * whatever opened it.
 */
export function MenuPopover({
  anchorRef,
  open,
  onClose,
  items,
  placement = "bottom",
  align = "start",
  getAnchorRect,
  label,
}: MenuPopoverProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    // After the popover has placed itself, so the browser does not scroll to where it first rendered.
    const frame = requestAnimationFrame(() => itemsOf(menuRef.current)[0]?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      // Back to the opener, unless the click that closed the menu sent the focus somewhere on purpose.
      const active = document.activeElement;
      if (!active || active === document.body || active.closest('[role="menu"]')) {
        before?.focus?.({ preventScroll: true });
      }
    };
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = itemsOf(menuRef.current);
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length].focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? list.length - 1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Tab") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <Popover anchorRef={anchorRef} getAnchorRect={getAnchorRect} open={open} onClose={onClose} placement={placement} align={align}>
      <div ref={menuRef} style={menu} role="menu" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((it, i) => {
          if (it.type === "separator") {
            return <div key={i} style={{ height: 1, background: "var(--border-subtle)", margin: "4px 0" }} />;
          }
          if (it.type === "label") {
            return (
              <div key={i} style={{ fontFamily: "var(--font-mono)", padding: "6px 8px 2px", fontSize: "var(--text-2xs)", fontWeight: 500, color: "var(--text-muted)" }}>
                {it.label}
              </div>
            );
          }
          return (
            <button
              key={i}
              type="button"
              role="menuitem"
              onClick={() => {
                it.onClick();
                onClose();
              }}
              style={{
                ...itemStyle,
                color: it.danger ? "var(--status-danger-fg)" : "var(--text-body)",
                background: it.active ? "var(--surface-selected)" : "transparent",
              }}
              onMouseEnter={(e) => {
                if (!it.active) e.currentTarget.style.background = "var(--surface-hover)";
              }}
              onMouseLeave={(e) => {
                if (!it.active) e.currentTarget.style.background = "transparent";
              }}
              onFocus={(e) => {
                if (!it.active) e.currentTarget.style.background = "var(--surface-hover)";
              }}
              onBlur={(e) => {
                if (!it.active) e.currentTarget.style.background = "transparent";
              }}
            >
              {it.icon ? <Icon name={it.icon} size={14} /> : null}
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</span>
              {it.active ? <Icon name="check" size={14} style={{ color: "var(--text-accent)" }} /> : null}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}
