import type { SpaceFile } from "@/lib/data";
import type { Translate } from "@/lib/i18n";
import type { ActionId, Entry, Sort, SortKey } from "./model";
import type { ClickModifiers } from "./useSelection";
import type { DragMove } from "./useDragMove";

/** One entry as the list shows it: the file, its model view, and what the person may do with it. */
export type Item = {
  key: string;
  file: SpaceFile;
  entry: Entry;
  /** Whether the person may rename, move, delete or replace it (see `canManage`). */
  manage: boolean;
  actions: ActionId[];
};

/** Where an entry's menu opens: under its ⋯ button, or where the pointer was (a right-click). */
export type MenuAt = { anchor: HTMLElement } | { x: number; y: number };

/** What the three list forms (desktop table, phone rows, grid) share. */
export type ListProps = {
  items: Item[];
  selected: Set<string>;
  sort: Sort;
  onSort: (key: SortKey) => void;
  onOpen: (item: Item) => void;
  onSelect: (item: Item, mods: ClickModifiers) => void;
  onToggle: (item: Item) => void;
  onToggleAll: () => void;
  onMenu: (item: Item, at: MenuAt) => void;
  /** A keyboard shortcut for one entry (F2, Delete). */
  onAction: (item: Item, action: ActionId) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  /** Dragging entries onto a folder (desktop only). */
  drag?: DragMove;
};

/** The modifiers of a click, Cmd standing for Ctrl on a Mac. */
export function modifiersOf(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): ClickModifiers {
  return { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
}

/** The model's view of a `SpaceFile`. */
export function entryOf(f: SpaceFile): Entry {
  return {
    id: f.id,
    name: f.name,
    isFolder: f.kind === "folder",
    sizeBytes: f.sizeBytes,
    childCount: f.childCount,
    updatedAt: f.updatedAt,
    modifiedBy: f.modifiedBy ?? f.by,
    ownerId: f.ownerId,
    parentFolderId: f.parentFolderId,
  };
}

/** A folder's size as the list shows it: how many entries, or that it is empty. */
export function folderSize(t: Translate, count: number | undefined): string {
  return count ? t("files.count", { count }) : t("files.emptyFolder");
}
