"use client";

import { type CSSProperties, type ReactNode, type RefObject } from "react";
import { Icon, Popover } from "@/components/ds";

const menu: CSSProperties = {
  minWidth: 224,
  maxWidth: 280,
  padding: 4,
  background: "var(--surface-canvas)",
  border: "1px solid var(--border-subtle)",
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
  fontSize: 13,
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
};

/** A dropdown menu rendered in a viewport-aware popover. */
export function MenuPopover({ anchorRef, open, onClose, items, placement = "bottom", align = "start" }: MenuPopoverProps) {
  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} placement={placement} align={align}>
      <div style={menu} role="menu">
        {items.map((it, i) => {
          if (it.type === "separator") {
            return <div key={i} style={{ height: 1, background: "var(--border-subtle)", margin: "4px 0" }} />;
          }
          if (it.type === "label") {
            return (
              <div key={i} style={{ padding: "6px 8px 2px", fontSize: 11, fontWeight: 600, letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-subtle)" }}>
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
