"use client";

import { type CSSProperties, useRef, useState } from "react";
import { Icon } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import { MenuPopover } from "../app/MenuPopover";
import type { Crumb } from "./useFolder";
import type { DragMove } from "./useDragMove";

/** Past this many steps (the root included), the middle ones fold into a "…" menu. */
const MAX_VISIBLE = 4;

const step: CSSProperties = {
  border: 0,
  background: "none",
  padding: "4px 6px",
  margin: "0 -2px",
  borderRadius: "var(--radius-sm)",
  font: "inherit",
  fontWeight: 400,
  color: "var(--text-muted)",
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
  maxWidth: 220,
};

/**
 * Where the list is, from the space's files down to the open folder. Every step but the last is a
 * way back there, and a place entries can be dropped into. A deep path keeps its root and its last
 * two steps; the ones between fold into a menu.
 */
export function Breadcrumb({
  rootLabel,
  trail,
  onOpen,
  drag,
}: {
  rootLabel: string;
  trail: Crumb[];
  onOpen: (folderId: string | undefined) => void;
  drag?: DragMove;
}) {
  const { t } = useTranslation();
  const steps: { id: string | undefined; name: string }[] = [{ id: undefined, name: rootLabel }, ...trail];
  const folded = steps.length > MAX_VISIBLE ? steps.slice(1, steps.length - 2) : [];
  const shown = folded.length > 0 ? [steps[0], null, ...steps.slice(steps.length - 2)] : steps;
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <nav aria-label={t("files.location")} style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 4, overflow: "hidden" }}>
      <Icon name="hard-drive" size={15} style={{ flex: "none", color: "var(--text-muted)" }} />
      {shown.map((s, i) => {
        const separator = i > 0 ? <Icon name="chevron-right" size={13} style={{ flex: "none", color: "var(--text-subtle)" }} /> : null;
        if (s === null) {
          return (
            <span key="more" style={{ display: "contents" }}>
              {separator}
              <button
                ref={moreRef}
                type="button"
                aria-label={t("files.hiddenFolders")}
                aria-haspopup="menu"
                style={{ ...step, flex: "none" }}
                onClick={() => setMoreOpen(true)}
              >
                …
              </button>
              <MenuPopover
                anchorRef={moreRef}
                open={moreOpen}
                onClose={() => setMoreOpen(false)}
                items={folded.map((f) => ({ icon: "folder", label: f.name, onClick: () => onOpen(f.id) }))}
              />
            </span>
          );
        }
        const last = i === shown.length - 1;
        const over = drag?.isOver(s.id ?? null);
        return (
          <span key={s.id ?? "root"} style={{ display: "contents" }}>
            {separator}
            {last ? (
              <span aria-current="page" style={{ ...step, cursor: "default", color: "var(--text-strong)", fontWeight: 700, maxWidth: 320 }}>
                {s.name}
              </span>
            ) : (
              <button
                type="button"
                style={{
                  ...step,
                  background: over ? "var(--surface-selected)" : "none",
                  outline: over ? "2px solid var(--text-accent)" : undefined,
                }}
                onClick={() => onOpen(s.id)}
                {...drag?.target(s.id ?? null)}
              >
                {s.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
