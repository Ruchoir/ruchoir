"use client";

import { type DragEvent, useRef, useState } from "react";
import type { Item } from "./listTypes";

/**
 * The type entries carry while dragged inside the list. A file dragged in from the desktop carries
 * `Files` instead, which is an upload and not a move: a target accepts this type only, so the two
 * never meet.
 */
export const DRAG_TYPE = "application/x-ruchoir-files";

/** The key a drop target is known by while something hovers it; the space root has no id. */
const ROOT = "__root__";

export type DragMove = {
  /** Props for an entry that may be dragged (nothing for one the person cannot move). */
  source: (item: Item) => Partial<{
    draggable: boolean;
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
  }>;
  /** Props for a folder entries may be dropped into (`null`: the space root). */
  target: (folderId: string | null) => {
    onDragOver: (e: DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent) => void;
  };
  /** Whether that folder is the one being hovered right now. */
  isOver: (folderId: string | null) => boolean;
  /** Whether a drag of entries is under way. */
  active: boolean;
};

/**
 * Moving entries by dragging them onto a folder of the list or a step of the breadcrumb.
 *
 * Dragging an entry that is part of the selection takes the whole selection with it (the entries
 * the person may move, that is). A folder never accepts itself, nor the folder the entries are
 * already in.
 */
export function useDragMove({
  selectedItems,
  currentFolderId,
  onMove,
}: {
  selectedItems: Item[];
  currentFolderId: string | undefined;
  onMove: (items: Item[], targetFolderId: string | null) => void;
}): DragMove {
  // The browser only tells a hovered target what types are dragged, never the data: the dragged
  // entries are held here.
  const dragged = useRef<Item[]>([]);
  const [over, setOver] = useState<string | null>(null);
  const [active, setActive] = useState(false);

  const accepts = (folderId: string | null) => {
    const items = dragged.current;
    if (items.length === 0) return false;
    if ((folderId ?? undefined) === currentFolderId) return false;
    return !items.some((i) => i.file.id === folderId);
  };

  return {
    source: (item) => {
      if (!item.manage || !item.file.id) return {};
      return {
        draggable: true,
        onDragStart: (e) => {
          const group = selectedItems.some((i) => i.key === item.key) ? selectedItems.filter((i) => i.manage && i.file.id) : [item];
          dragged.current = group;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(group.map((i) => i.file.id)));
          setActive(true);
        },
        onDragEnd: () => {
          dragged.current = [];
          setActive(false);
          setOver(null);
        },
      };
    },
    target: (folderId) => ({
      onDragOver: (e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE) || !accepts(folderId)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(folderId ?? ROOT);
      },
      onDragLeave: () => setOver((prev) => (prev === (folderId ?? ROOT) ? null : prev)),
      onDrop: (e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE) || !accepts(folderId)) return;
        e.preventDefault();
        const items = dragged.current;
        dragged.current = [];
        setOver(null);
        setActive(false);
        onMove(items, folderId);
      },
    }),
    isOver: (folderId) => over === (folderId ?? ROOT),
    active,
  };
}
