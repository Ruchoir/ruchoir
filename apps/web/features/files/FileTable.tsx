"use client";

import { type CSSProperties, type KeyboardEvent, useRef, useState } from "react";
import { Avatar, Checkbox, FileIcon, Icon, IconButton } from "@/components/ds";
import { getAvatar } from "@/lib/data";
import { useTranslation } from "@/lib/i18n";
import { formatBytes, formatStamp } from "@/lib/i18n/format";
import { EditingBadge } from "@/features/office/EditingBadge";
import type { SortKey } from "./model";
import { FileName } from "./FileName";
import { folderSize, type Item, type ListProps, modifiersOf } from "./listTypes";

const styles: Record<string, CSSProperties> = {
  wrap: {
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
    background: "var(--surface-card)",
  },
  table: { width: "100%", borderCollapse: "collapse", tableLayout: "fixed" },
  th: {
    fontFamily: "var(--font-mono)",
    height: 36,
    textAlign: "left",
    fontSize: "var(--text-2xs)",
    fontWeight: 500,
    color: "var(--text-muted)",
    padding: "0 12px",
    background: "var(--surface-canvas)",
    borderBottom: "1.5px solid var(--border-subtle)",
    verticalAlign: "middle",
    whiteSpace: "nowrap",
  },
  sortButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    border: 0,
    padding: 0,
    background: "none",
    font: "inherit",
    color: "inherit",
    cursor: "pointer",
  },
  td: {
    height: 46,
    paddingBlock: 4,
    padding: "0 12px",
    borderBottom: "1px solid var(--border-subtle)",
    fontSize: "var(--text-xs)",
    color: "var(--text-body)",
    verticalAlign: "middle",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
  center: { display: "flex", alignItems: "center", justifyContent: "center" },
  name: {
    display: "inline-flex",
    alignItems: "center",
    gap: 9,
    maxWidth: "100%",
    minWidth: 0,
    border: 0,
    padding: 0,
    background: "none",
    font: "inherit",
    color: "var(--text-strong)",
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "left",
  },
};

/**
 * The desktop list: a table sorted from its headings, with the selection, the menus and the keyboard
 * of a desktop file manager.
 *
 * A click on the name opens the entry; anywhere else on the row selects it (Ctrl or Cmd to add,
 * Shift for a range); a double click anywhere opens it; a right click opens its menu where the
 * pointer is. One row at a time takes the focus (the others leave the tab order), and the arrows walk
 * the list.
 */
export function FileTable(props: ListProps) {
  const { items, selected, sort, onSort, onToggleAll } = props;
  const { t } = useTranslation();
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // The row that holds the tab stop: the one last focused, else the first selected, else the first.
  const tabKey =
    (focusKey && items.some((i) => i.key === focusKey) ? focusKey : null) ??
    items.find((i) => selected.has(i.key))?.key ??
    items[0]?.key;

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.key));
  const someSelected = !allSelected && items.some((i) => selected.has(i.key));

  const focusRow = (key: string) => {
    setFocusKey(key);
    rowRefs.current.get(key)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, item: Item) => {
    // Enter or Space on the row's own ⋯ button is that button's to handle.
    if (e.target !== e.currentTarget && (e.key === "Enter" || e.key === " ")) return;
    const at = items.findIndex((i) => i.key === item.key);
    const mods = modifiersOf(e);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = items[at + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      focusRow(next.key);
      props.onSelect(next, { ctrl: false, shift: mods.shift });
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const next = e.key === "Home" ? items[0] : items[items.length - 1];
      focusRow(next.key);
      props.onSelect(next, { ctrl: false, shift: mods.shift });
    } else if (e.key === "Enter") {
      e.preventDefault();
      props.onOpen(item);
    } else if (e.key === " ") {
      e.preventDefault();
      props.onToggle(item);
    } else if (e.key === "F2") {
      e.preventDefault();
      props.onAction(item, "rename");
    } else if (e.key === "Delete") {
      e.preventDefault();
      props.onAction(item, "delete");
    } else if (e.key.toLowerCase() === "a" && mods.ctrl) {
      e.preventDefault();
      props.onSelectAll();
    } else if (e.key === "Escape" && selected.size > 0) {
      e.preventDefault();
      props.onClearSelection();
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      props.onMenu(item, { anchor: e.currentTarget });
    }
  };

  const heading = (key: SortKey, label: string) => {
    const active = sort.key === key;
    return (
      <th style={styles.th} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
        <button type="button" style={{ ...styles.sortButton, color: active ? "var(--text-strong)" : undefined }} onClick={() => onSort(key)}>
          {label}
          {active ? <Icon name={sort.dir === "asc" ? "arrow-up" : "arrow-down"} size={12} /> : null}
        </button>
      </th>
    );
  };

  return (
    <div style={styles.wrap}>
      <table style={styles.table} aria-multiselectable="true">
        <colgroup>
          <col style={{ width: 44 }} />
          <col />
          <col style={{ width: 180 }} />
          <col style={{ width: 132 }} />
          <col style={{ width: 112 }} />
          <col style={{ width: 52 }} />
        </colgroup>
        <thead>
          <tr>
            <th style={styles.th}>
              <span style={styles.center}>
                <Checkbox checked={allSelected} indeterminate={someSelected} onChange={onToggleAll} aria-label={t("files.selectAll")} />
              </span>
            </th>
            {heading("name", t("files.name"))}
            {heading("modifiedBy", t("files.modifiedBy"))}
            {heading("updatedAt", t("files.modified"))}
            {heading("size", t("files.size"))}
            <th style={styles.th} aria-label={t("files.actions")} />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <Row
              key={item.key}
              item={item}
              props={props}
              checked={selected.has(item.key)}
              tabbable={item.key === tabKey}
              rowRef={(el) => {
                if (el) rowRefs.current.set(item.key, el);
                else rowRefs.current.delete(item.key);
              }}
              onFocus={() => setFocusKey(item.key)}
              onKeyDown={(e) => onKeyDown(e, item)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  item,
  props,
  checked,
  tabbable,
  rowRef,
  onFocus,
  onKeyDown,
}: {
  item: Item;
  props: ListProps;
  checked: boolean;
  tabbable: boolean;
  rowRef: (el: HTMLTableRowElement | null) => void;
  onFocus: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => void;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const { file: f, entry } = item;
  const drop = entry.isFolder && f.id && props.drag ? props.drag.target(f.id) : null;
  const over = !!(f.id && props.drag?.isOver(f.id));
  const modifiedBy = f.modifiedBy ?? f.by;

  return (
    <tr
      ref={rowRef}
      tabIndex={tabbable ? 0 : -1}
      aria-selected={checked}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => props.onSelect(item, modifiersOf(e))}
      onDoubleClick={() => props.onOpen(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!checked) props.onSelect(item, { ctrl: false, shift: false });
        props.onMenu(item, { x: e.clientX, y: e.clientY });
      }}
      {...props.drag?.source(item)}
      {...drop}
      style={{
        background: over ? "var(--surface-selected)" : checked ? "var(--surface-selected)" : hover ? "var(--surface-hover)" : "transparent",
        outline: over ? "2px solid var(--text-accent)" : undefined,
        outlineOffset: -2,
        cursor: "default",
        userSelect: "none",
      }}
    >
      <td style={styles.td} onClick={(e) => e.stopPropagation()}>
        <span style={styles.center}>
          <Checkbox checked={checked} onChange={() => props.onToggle(item)} aria-label={t("files.select", { name: f.name })} tabIndex={-1} />
        </span>
      </td>
      <td style={styles.td}>
        <button
          type="button"
          tabIndex={-1}
          title={f.name}
          style={styles.name}
          onClick={(e) => {
            // Ctrl, Cmd or Shift on the name is still a selection, as everywhere else on the row.
            if (e.ctrlKey || e.metaKey || e.shiftKey) return;
            e.stopPropagation();
            props.onOpen(item);
          }}
        >
          {entry.isFolder ? (
            <Icon name="folder" size={18} style={{ flex: "none", color: "var(--ink)" }} />
          ) : (
            <FileIcon name={f.name} size={22} />
          )}
          {item.location ? (
            // In a view beyond a folder, where it lives goes under its name.
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 1 }}>
              <FileName name={f.name} isFolder={entry.isFolder} />
              <span style={{ fontSize: "var(--text-2xs)", fontWeight: 400, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.location}
              </span>
            </span>
          ) : (
            <FileName name={f.name} isFolder={entry.isFolder} />
          )}
          {entry.starred ? <Icon name="star" size={13} title={t("files.favourite")} style={{ flex: "none", color: "var(--status-warning-fg, var(--text-accent))", fill: "currentColor" }} /> : null}
          <EditingBadge editors={f.editors} size={16} />
        </button>
      </td>
      <td style={styles.td}>
        {modifiedBy ? (
          <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <Avatar name={modifiedBy} src={getAvatar(modifiedBy)} size={20} />
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{modifiedBy}</span>
          </span>
        ) : null}
      </td>
      <td style={{ ...styles.td, color: "var(--text-muted)" }}>{formatStamp(f.updatedAt)}</td>
      <td style={{ ...styles.td, color: "var(--text-muted)" }}>
        {entry.isFolder ? folderSize(t, f.childCount) : formatBytes(f.sizeBytes)}
      </td>
      <td style={styles.td} onClick={(e) => e.stopPropagation()}>
        <span style={styles.center}>
          <IconButton
            icon="more-horizontal"
            label={t("sidebar.actionsFor", { name: f.name })}
            size="sm"
            // Reachable from the row holding the tab stop, so the menu has a way in besides Shift+F10.
            tabIndex={tabbable ? 0 : -1}
            aria-haspopup="menu"
            style={{ opacity: hover || checked ? 1 : 0.55 }}
            onClick={(e) => props.onMenu(item, { anchor: e.currentTarget })}
          />
        </span>
      </td>
    </tr>
  );
}
