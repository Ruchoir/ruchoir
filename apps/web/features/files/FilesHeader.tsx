"use client";

import { type CSSProperties, type ReactNode, useState } from "react";
import { Button, IconButton, Input } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import { ActionMenu, type MenuEntry } from "./ActionMenu";
import { Breadcrumb } from "./Breadcrumb";
import type { MenuAt } from "./listTypes";
import type { Sort, SortKey } from "./model";
import type { DragMove } from "./useDragMove";
import type { Crumb } from "./useFolder";

const bar: CSSProperties = {
  height: "var(--topbar-height)",
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0 12px 0 20px",
  borderBottom: "1.5px solid var(--border-subtle)",
  minWidth: 0,
};

/** The page's heading, for a screen reader: the breadcrumb already shows it on the screen. */
const hidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export type Layout = "list" | "grid";

export type SelectionState = {
  count: number;
  /** Whether any selected entry may be moved, or removed, by this person. */
  canMove: boolean;
  canDelete: boolean;
  onMove: () => void;
  onDelete: () => void;
  onClear: () => void;
};

/**
 * The files screen's one bar. On a desktop: where the list is, a filter, list or grid, the details
 * panel and "+ New". On a phone: the way back, the folder's name, and a search and a view menu.
 * While entries are selected, the bar becomes the selection's: how many, and what can be done with
 * them all at once.
 */
export function FilesHeader({
  compact,
  rootLabel,
  trail,
  onOpenFolder,
  onBack,
  drag,
  query,
  onQuery,
  layout,
  onLayout,
  sort,
  onSort,
  detailsOpen,
  onToggleDetails,
  newButton,
  selection,
  minimal = false,
}: {
  /** A view with nothing to browse (the trash): its name, and on a phone the way back. */
  minimal?: boolean;
  compact: boolean;
  rootLabel: string;
  trail: Crumb[];
  onOpenFolder: (id: string | undefined) => void;
  /** At the root of a phone: back to the app's tabs. */
  onBack?: () => void;
  drag?: DragMove;
  query: string;
  onQuery: (q: string) => void;
  layout: Layout;
  onLayout: (layout: Layout) => void;
  sort: Sort;
  onSort: (sort: Sort) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /** "+ New" (desktop only: a phone has its floating button). */
  newButton?: ReactNode;
  selection: SelectionState | null;
}) {
  const { t } = useTranslation();
  const [searching, setSearching] = useState(false);
  const [viewAt, setViewAt] = useState<MenuAt | null>(null);
  const current = trail.length > 0 ? trail[trail.length - 1].name : rootLabel;
  const parent = trail.length > 1 ? trail[trail.length - 2].id : undefined;

  const sortLabels: Record<SortKey, string> = {
    name: t("files.name"),
    updatedAt: t("files.modified"),
    size: t("files.size"),
    modifiedBy: t("files.modifiedBy"),
  };
  const viewEntries: MenuEntry[] = [
    ...(["name", "updatedAt", "size", "modifiedBy"] as SortKey[]).map((key) => ({
      label: sortLabels[key],
      icon: (sort.key === key ? (sort.dir === "asc" ? "arrow-up" : "arrow-down") : "arrow-up-down") as "arrow-up" | "arrow-down" | "arrow-up-down",
      active: sort.key === key,
      // Choosing the current key again turns the order round, as a column heading does.
      onSelect: () => onSort(sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "updatedAt" ? "desc" : "asc" }),
    })),
    { separator: true },
    { label: t("files.listView"), icon: "list", active: layout === "list", onSelect: () => onLayout("list") },
    { label: t("files.gridView"), icon: "layout-grid", active: layout === "grid", onSelect: () => onLayout("grid") },
  ];
  const viewMenu = (
    <ActionMenu
      open={viewAt != null}
      at={viewAt}
      title={t("files.display")}
      entries={compact ? viewEntries : viewEntries.slice(0, 4)}
      sheet={compact}
      onClose={() => setViewAt(null)}
    />
  );

  if (selection) {
    return (
      <div style={{ ...bar, padding: compact ? "0 8px" : bar.padding, background: "var(--surface-selected)" }} role="toolbar" aria-label={t("files.selectedCount", { count: selection.count })}>
        <IconButton icon="x" label={t("files.clearSelection")} onClick={selection.onClear} style={compact ? { width: 44, height: 44 } : undefined} />
        <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)", whiteSpace: "nowrap" }}>
          {t("files.selectedCount", { count: selection.count })}
        </span>
        <div style={{ flex: 1 }} />
        {selection.canMove ? (
          compact ? (
            <IconButton icon="arrow-right" label={t("files.move")} onClick={selection.onMove} style={{ width: 44, height: 44 }} />
          ) : (
            <Button size="sm" iconLeft="arrow-right" onClick={selection.onMove}>
              {t("files.move")}
            </Button>
          )
        ) : null}
        {selection.canDelete ? (
          compact ? (
            <IconButton icon="trash-2" label={t("common.delete")} onClick={selection.onDelete} style={{ width: 44, height: 44 }} />
          ) : (
            <Button size="sm" variant="danger" iconLeft="trash-2" onClick={selection.onDelete}>
              {t("common.delete")}
            </Button>
          )
        ) : null}
        {/* The details of what is selected are the reason to open the panel at all. */}
        {compact ? null : <IconButton icon="info" label={t("files.details")} size="sm" aria-pressed={detailsOpen} onClick={onToggleDetails} />}
      </div>
    );
  }

  if (minimal) {
    return (
      <div style={compact ? { ...bar, padding: "0 4px", gap: 4 } : bar}>
        {compact && onBack ? (
          <IconButton icon="arrow-left" label={t("common.back")} onClick={onBack} style={{ width: 44, height: 44, flex: "none" }} />
        ) : null}
        <h1 style={{ margin: compact ? 0 : "0", fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--text-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {rootLabel}
        </h1>
      </div>
    );
  }

  if (compact) {
    return (
      <div style={{ ...bar, padding: "0 4px 0 4px", gap: 4 }}>
        <h1 style={hidden}>{current}</h1>
        {searching ? (
          <>
            <div style={{ flex: 1, minWidth: 0, paddingLeft: 8 }}>
              <Input
                size="sm"
                icon="search"
                autoFocus
                placeholder={t("files.filter")}
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    onQuery("");
                    setSearching(false);
                  }
                }}
              />
            </div>
            <IconButton
              icon="x"
              label={t("common.close")}
              onClick={() => {
                onQuery("");
                setSearching(false);
              }}
              style={{ width: 44, height: 44, flex: "none" }}
            />
          </>
        ) : (
          <>
            {trail.length > 0 || onBack ? (
              <IconButton
                icon="arrow-left"
                label={t("common.back")}
                onClick={() => (trail.length > 0 ? onOpenFolder(parent) : onBack?.())}
                style={{ width: 44, height: 44, flex: "none" }}
              />
            ) : null}
            <span
              aria-hidden
              style={{ flex: 1, minWidth: 0, fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--text-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            >
              {current}
            </span>
            <IconButton icon="search" label={t("files.filter")} onClick={() => setSearching(true)} style={{ width: 44, height: 44, flex: "none" }} />
            <IconButton
              icon="arrow-up-down"
              label={t("files.display")}
              aria-haspopup="menu"
              onClick={(e) => setViewAt({ anchor: e.currentTarget })}
              style={{ width: 44, height: 44, flex: "none" }}
            />
            {viewMenu}
          </>
        )}
      </div>
    );
  }

  return (
    <div style={bar}>
      <h1 style={hidden}>{current}</h1>
      <Breadcrumb rootLabel={rootLabel} trail={trail} onOpen={onOpenFolder} drag={drag} />
      <div style={{ flex: 1 }} />
      <div style={{ width: 220, flex: "0 1 220px", minWidth: 120 }}>
        <Input size="sm" icon="search" placeholder={t("files.filter")} value={query} onChange={(e) => onQuery(e.target.value)} />
      </div>
      {layout === "grid" ? (
        <>
          <IconButton icon="arrow-up-down" label={t("files.sortBy")} size="sm" aria-haspopup="menu" onClick={(e) => setViewAt({ anchor: e.currentTarget })} />
          {viewMenu}
        </>
      ) : null}
      <IconButton icon="list" label={t("files.listView")} size="sm" aria-pressed={layout === "list"} onClick={() => onLayout("list")} />
      <IconButton icon="layout-grid" label={t("files.gridView")} size="sm" aria-pressed={layout === "grid"} onClick={() => onLayout("grid")} />
      <IconButton icon="info" label={t("files.details")} size="sm" aria-pressed={detailsOpen} onClick={onToggleDetails} />
      {newButton}
    </div>
  );
}
