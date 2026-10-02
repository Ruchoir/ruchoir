"use client";

import { type CSSProperties, type KeyboardEvent, useState } from "react";
import { Checkbox, FileIcon, Icon, IconButton } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import { formatBytes } from "@/lib/i18n/format";
import { EditingBadge } from "@/features/office/EditingBadge";
import { FileName } from "./FileName";
import { folderSize, type Item, type ListProps, modifiersOf } from "./listTypes";
import { useLongPress } from "./useLongPress";

const styles: Record<string, CSSProperties> = {
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(168px, 100%), 1fr))", gap: 12 },
  section: {
    margin: "0 0 10px",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    fontWeight: 500,
    color: "var(--text-muted)",
  },
  card: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 8,
    borderRadius: "var(--radius-md)",
    // Longhands only: a shorthand border with its colour changed beside it loses the colour when the
    // change is undone, and the border falls back to the text's colour.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border-subtle)",
    background: "var(--surface-card)",
    cursor: "default",
    userSelect: "none",
    WebkitTouchCallout: "none",
  },
  /** Fixed-height preview area, so cards stay aligned whatever each file turns out to be. */
  preview: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: 104,
    borderRadius: "var(--radius-sm)",
    background: "var(--surface-sunken)",
    overflow: "hidden",
  },
  name: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    fontSize: "var(--text-xs)",
    fontWeight: 500,
    color: "var(--text-strong)",
  },
};

/**
 * The grid: folders first as compact tiles, then a card per file with its thumbnail when the server
 * made one, for photos and anything better recognised by sight. Selection and menus behave as in the
 * table; the arrows are left to the table, where a row has one neighbour above and one below.
 */
export function FileGrid(props: ListProps & { touch: boolean }) {
  const { t } = useTranslation();
  const selecting = props.selected.size > 0;
  const folders = props.items.filter((i) => i.entry.isFolder);
  const files = props.items.filter((i) => !i.entry.isFolder);
  const section = (label: string, items: Item[], wide: boolean) =>
    items.length > 0 ? (
      <section style={{ marginBottom: 20 }}>
        <h2 style={styles.section}>{label}</h2>
        <div style={wide ? { ...styles.grid, gridTemplateColumns: "1fr" } : styles.grid} role="list">
          {items.map((item) => (
            <Card key={item.key} item={item} props={props} checked={props.selected.has(item.key)} selecting={selecting} />
          ))}
        </div>
      </section>
    ) : null;
  return (
    <>
      {/* On a phone a folder tile takes the whole width: two side by side left room for a few
          letters of each name. */}
      {section(t("files.foldersSection"), folders, props.touch)}
      {section(t("gsearch.files"), files, false)}
    </>
  );
}

function Card({
  item,
  props,
  checked,
  selecting,
}: {
  item: Item;
  props: ListProps & { touch: boolean };
  checked: boolean;
  selecting: boolean;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const { file: f, entry } = item;
  const drop = entry.isFolder && f.id && props.drag ? props.drag.target(f.id) : null;
  const over = !!(f.id && props.drag?.isOver(f.id));
  const longPress = useLongPress(() => props.onToggle(item));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
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
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      props.onMenu(item, { anchor: e.currentTarget });
    }
  };

  return (
    <div
      role="listitem"
      tabIndex={0}
      aria-label={f.name}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...(props.touch ? longPress.handlers : null)}
      onClick={(e) => {
        if (longPress.consumeClick()) return;
        // On a phone a tap opens, or toggles once a selection has started; with a mouse, a click
        // selects and a double click opens, as in the table.
        if (props.touch) {
          if (selecting) props.onToggle(item);
          else props.onOpen(item);
        } else {
          props.onSelect(item, modifiersOf(e));
        }
      }}
      onDoubleClick={() => !props.touch && props.onOpen(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (props.touch) return;
        if (!checked) props.onSelect(item, { ctrl: false, shift: false });
        props.onMenu(item, { x: e.clientX, y: e.clientY });
      }}
      {...props.drag?.source(item)}
      {...drop}
      style={{
        ...styles.card,
        borderColor: over || checked ? "var(--text-accent)" : hover ? "var(--border-default)" : "var(--border-subtle)",
        background: checked || over ? "var(--surface-selected)" : hover ? "var(--surface-hover)" : "var(--surface-card)",
      }}
    >
      {/* A file's card is big enough to show what it is: the API stored a thumbnail at upload. A
          folder has nothing to show but its name, so it is a tile rather than a card. */}
      {entry.isFolder ? null : (
        <div style={styles.preview}>
          {f.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- same-origin, served by our own API
            <img src={f.thumbnailUrl} alt="" loading="lazy" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <FileIcon name={f.name} size={44} />
          )}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: entry.isFolder ? 10 : 4, minWidth: 0 }}>
        {entry.isFolder ? <Icon name="folder" size={20} style={{ flex: "none", color: "var(--ink)", marginLeft: 4 }} /> : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.name}>
            <FileName name={f.name} isFolder={entry.isFolder} />
            <EditingBadge editors={f.editors} size={14} />
          </div>
          <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {entry.isFolder ? folderSize(t, f.childCount) : formatBytes(f.sizeBytes)}
          </div>
        </div>
        <IconButton
          icon="more-horizontal"
          label={t("sidebar.actionsFor", { name: f.name })}
          size="sm"
          aria-haspopup="menu"
          style={props.touch ? { width: 40, height: 40, flex: "none" } : { flex: "none" }}
          onClick={(e) => {
            e.stopPropagation();
            props.onMenu(item, { anchor: e.currentTarget });
          }}
        />
      </div>
      {!props.touch && (hover || selecting) ? (
        <span style={{ position: "absolute", top: entry.isFolder ? -8 : 12, left: entry.isFolder ? -8 : 12 }} onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={checked} onChange={() => props.onToggle(item)} aria-label={t("files.select", { name: f.name })} />
        </span>
      ) : null}
    </div>
  );
}
