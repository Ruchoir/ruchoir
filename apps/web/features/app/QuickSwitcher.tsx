"use client";

import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useMemo, useRef, useState } from "react";
import { Avatar, Badge, Dialog, EmptyState, Icon } from "@/components/ds";
import type { Channel, DirectMessage, Workspace } from "@/lib/data";
import { getAvatar } from "@/lib/data";

const styles: Record<string, CSSProperties> = {
  search: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-md)",
    marginBottom: 8,
  },
  input: {
    flex: 1,
    border: 0,
    outline: "none",
    background: "none",
    fontFamily: "inherit",
    fontSize: 14,
    color: "var(--text-strong)",
  },
  list: { maxHeight: 360, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    padding: "8px 10px",
    border: 0,
    borderRadius: "var(--radius-md)",
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
  },
  name: { flex: 1, minWidth: 0, fontSize: 13, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  kind: { fontSize: 11, color: "var(--text-subtle)" },
  foot: { display: "flex", gap: 14, padding: "8px 2px 0", fontSize: 11, color: "var(--text-subtle)" },
};

type Entry = {
  id: string;
  name: string;
  kind: "channel" | "dm" | "space";
  unread: number;
  channel?: Channel;
  dm?: DirectMessage;
  /** A space's uploaded icon; absent falls back to the generated mark. */
  iconUrl?: string;
};

export type QuickSwitcherProps = {
  channels: Channel[];
  dms: DirectMessage[];
  /** The other spaces the caller belongs to; the open one is not offered as a destination. */
  spaces: Workspace[];
  onOpen: (id: string) => void;
  /** Switch to another space. Separate from `onOpen`, which addresses a conversation. */
  onOpenSpace: (id: string) => void;
  onClose: () => void;
};

/**
 * Jump straight to a channel, a direct message or another space, filtered by name and driven from
 * the keyboard.
 *
 * Spaces belong here because switching between them is the same intent as switching conversation,
 * and reaching them only through the rail means a mouse. They are listed last with no query, so the
 * common case (a conversation in the space you are already in) stays first.
 */
export function QuickSwitcher({ channels, dms, spaces, onOpen, onOpenSpace, onClose }: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const all: Entry[] = useMemo(
    () => [
      ...channels.map((c) => ({ id: c.id, name: c.name, kind: "channel" as const, unread: c.unread, channel: c })),
      ...dms.map((d) => ({ id: d.id, name: d.name, kind: "dm" as const, unread: d.unread, dm: d })),
      // A space's counter is its mention count: the same number the rail shows, so the two never
      // disagree about what is waiting there.
      ...spaces.map((w) => ({
        id: w.id,
        name: w.name,
        kind: "space" as const,
        unread: w.mentions,
        iconUrl: w.iconUrl,
      })),
    ],
    [channels, dms, spaces],
  );

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) {
      // With no query, surface unread conversations first so the switcher is useful on open.
      return [...all].sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0)).slice(0, 12);
    }
    return all.filter((e) => e.name.toLowerCase().includes(q)).slice(0, 12);
  }, [q, all]);

  const clamp = (i: number) => Math.max(0, Math.min(results.length - 1, i));
  const scrollTo = (i: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${i}"]`);
    el?.scrollIntoView({ block: "nearest" });
  };

  const choose = (i: number) => {
    const entry = results[i];
    if (!entry) return;
    if (entry.kind === "space") onOpenSpace(entry.id);
    else onOpen(entry.id);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = clamp(active + 1);
      setActive(next);
      scrollTo(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = clamp(active - 1);
      setActive(next);
      scrollTo(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    }
  };

  return (
    <Dialog title="Aller à une conversation" size="md" onClose={onClose}>
      <div style={styles.search}>
        <Icon name="search" size={16} style={{ color: "var(--text-subtle)" }} />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          aria-label="Filtrer les conversations"
          placeholder="Nom d'un canal, d'une personne ou d'un espace…"
          style={styles.input}
        />
      </div>

      <div ref={listRef} style={styles.list} role="listbox" aria-label="Conversations">
        {results.length === 0 ? (
          <EmptyState size="compact" icon="search" title="Aucune conversation" description={`Rien ne correspond à « ${query} ».`} />
        ) : (
          results.map((e, i) => {
            const selected = i === active;
            return (
              <button
                key={`${e.kind}:${e.id}`}
                type="button"
                role="option"
                aria-selected={selected}
                data-idx={i}
                className="wc-listrow"
                style={{ ...styles.row, background: selected ? "var(--surface-selected)" : "transparent" }}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(i)}
              >
                {e.kind === "channel" ? (
                  <Icon name="hash" size={18} style={{ color: "var(--text-muted)", flex: "none" }} />
                ) : e.kind === "space" ? (
                  <Avatar name={e.name} src={e.iconUrl} kind="workspace" size={22} />
                ) : (
                  <Avatar name={e.name} src={getAvatar(e.name)} size={22} presence={e.dm?.presence} />
                )}
                <span style={styles.name}>
                  {e.name}
                  {e.kind === "space" ? <span style={styles.kind}> espace</span> : null}
                </span>
                {e.unread > 0 ? <Badge count={e.unread} /> : null}
              </button>
            );
          })
        )}
      </div>

      <div style={styles.foot}>
        <span>↑ ↓ pour naviguer</span>
        <span>Entrée pour ouvrir</span>
        <span>Échap pour fermer</span>
      </div>
    </Dialog>
  );
}
