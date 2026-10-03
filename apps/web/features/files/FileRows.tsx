"use client";

import type { CSSProperties } from "react";
import { Checkbox, FileIcon, Icon, IconButton } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import { formatBytes, formatStamp } from "@/lib/i18n/format";
import { EditingBadge } from "@/features/office/EditingBadge";
import { FileName } from "./FileName";
import { folderSize, type Item, type ListProps } from "./listTypes";
import { useLongPress } from "./useLongPress";

const styles: Record<string, CSSProperties> = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    padding: "6px 4px 6px 12px",
    borderBottom: "1px solid var(--border-subtle)",
    userSelect: "none",
    WebkitUserSelect: "none",
    WebkitTouchCallout: "none",
    cursor: "pointer",
  },
  main: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 },
  name: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: "var(--text-sm)",
    fontWeight: 500,
    color: "var(--text-strong)",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  meta: {
    fontSize: "var(--text-2xs)",
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
};

/**
 * The phone list: one row per entry, its name whole (shortened in the middle so the extension
 * stays), who changed it, when and how big underneath, and a ⋯ for its actions.
 *
 * A tap opens. A long press selects, and from then on a tap adds or removes a row, until the
 * selection is empty again: the gesture every phone file manager uses.
 */
export function FileRows(props: ListProps) {
  const selecting = props.selected.size > 0;
  return (
    <div role="list">
      {props.items.map((item) => (
        <Row key={item.key} item={item} props={props} checked={props.selected.has(item.key)} selecting={selecting} />
      ))}
    </div>
  );
}

function Row({ item, props, checked, selecting }: { item: Item; props: ListProps; checked: boolean; selecting: boolean }) {
  const { t } = useTranslation();
  const { file: f, entry } = item;
  const longPress = useLongPress(() => props.onToggle(item));

  const meta = entry.isFolder
    ? folderSize(t, f.childCount)
    : [f.modifiedBy ?? f.by, formatStamp(f.updatedAt), formatBytes(f.sizeBytes)].filter(Boolean).join(" · ");

  return (
    <div
      role="listitem"
      style={{ ...styles.row, background: checked ? "var(--surface-selected)" : undefined }}
      {...longPress.handlers}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (longPress.consumeClick()) return;
        if (selecting) props.onToggle(item);
        else props.onOpen(item);
      }}
    >
      {selecting ? (
        <span onClick={(e) => e.stopPropagation()} style={{ display: "flex" }}>
          <Checkbox checked={checked} onChange={() => props.onToggle(item)} aria-label={t("files.select", { name: f.name })} />
        </span>
      ) : null}
      <span style={{ flex: "none", width: 28, display: "flex", justifyContent: "center" }}>
        {entry.isFolder ? <Icon name="folder" size={22} style={{ color: "var(--ink)" }} /> : <FileIcon name={f.name} size={28} />}
      </span>
      <span style={styles.main}>
        <span style={styles.name}>
          {/* A button for the screen reader and the keyboard; the row takes the finger. */}
          <button
            type="button"
            aria-label={f.name}
            onClick={(e) => {
              e.stopPropagation();
              if (longPress.consumeClick()) return;
              if (selecting) props.onToggle(item);
              else props.onOpen(item);
            }}
            style={{ display: "flex", border: 0, padding: 0, background: "none", font: "inherit", color: "inherit", cursor: "inherit", minWidth: 0, textAlign: "left" }}
          >
            <FileName name={f.name} isFolder={entry.isFolder} />
          </button>
          <EditingBadge editors={f.editors} size={16} />
        </span>
        <span style={styles.meta}>{meta}</span>
      </span>
      <IconButton
        icon="more-horizontal"
        label={t("sidebar.actionsFor", { name: f.name })}
        aria-haspopup="menu"
        style={{ width: 44, height: 44, flex: "none" }}
        onClick={(e) => {
          e.stopPropagation();
          props.onMenu(item, { anchor: e.currentTarget });
        }}
      />
    </div>
  );
}
