"use client";

import { useMemo } from "react";
import { Icon, type IconName, Sheet, SheetGroup, SheetItem } from "@/components/ds";
import { MenuPopover, type MenuItem } from "../app/MenuPopover";
import type { MenuAt } from "./listTypes";

export type MenuEntry =
  | {
      label: string;
      icon: IconName;
      danger?: boolean;
      /** A choice currently in force (a sort, a layout): drawn with a check. */
      active?: boolean;
      onSelect: () => void;
    }
  | { separator: true };

/**
 * An entry's actions, drawn the way the pointer calls for: a menu under the ⋯ or at the pointer on a
 * desktop, a sheet rising from the bottom on a phone. What it lists is decided by the caller, from
 * `actionsFor`, so every surface offers the same thing in the same order.
 */
export function ActionMenu({
  open,
  at,
  title,
  entries,
  sheet,
  onClose,
}: {
  open: boolean;
  at: MenuAt | null;
  /** The entry's name: the sheet's heading, and the menu's accessible name. */
  title: string;
  entries: MenuEntry[];
  /** Draw a sheet rather than a menu (a phone). */
  sheet: boolean;
  onClose: () => void;
}) {
  // A ref-shaped holder for the ⋯ that opened the menu (none for a right click, placed by point).
  const anchorRef = useMemo(() => ({ current: at && "anchor" in at ? at.anchor : null }), [at]);
  const point = at && "x" in at ? at : null;

  if (sheet) {
    // Split into groups at the separators, as the sheet draws its groups apart.
    const groups: MenuEntry[][] = [[]];
    for (const entry of entries) {
      if ("separator" in entry) groups.push([]);
      else groups[groups.length - 1].push(entry);
    }
    return (
      <Sheet open={open} label={title} heading onClose={onClose}>
        {groups
          .filter((g) => g.length > 0)
          .map((group, i) => (
            <SheetGroup key={i}>
              {group.map((entry) =>
                "separator" in entry ? null : (
                  <SheetItem
                    key={entry.label}
                    icon={entry.icon}
                    label={entry.label}
                    danger={entry.danger}
                    selected={entry.active}
                    trailing={entry.active ? <Icon name="check" size={16} style={{ color: "var(--text-accent)" }} /> : undefined}
                    onClick={() => {
                      onClose();
                      entry.onSelect();
                    }}
                  />
                ),
              )}
            </SheetGroup>
          ))}
      </Sheet>
    );
  }

  const items: MenuItem[] = entries.map((entry) =>
    "separator" in entry ? { type: "separator" } : { icon: entry.icon, label: entry.label, danger: entry.danger, active: entry.active, onClick: entry.onSelect },
  );
  return (
    <MenuPopover
      anchorRef={anchorRef}
      getAnchorRect={point ? () => new DOMRect(point.x, point.y, 0, 0) : undefined}
      open={open}
      onClose={onClose}
      items={items}
      placement="bottom"
      align={point ? "start" : "end"}
      label={title}
    />
  );
}
