"use client";

import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, Dialog, EmptyState, Icon } from "@/components/ds";
import type { Presence } from "@/components/ds";
import { type FileHit, search, type SearchMessage } from "@/lib/data/api";
import { getAvatar } from "@/lib/data";
import { messageSummary } from "./activity";

const styles: Record<string, CSSProperties> = {
  label: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
    padding: "12px 4px 4px",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    width: "100%",
    padding: "8px 10px",
    border: 0,
    borderRadius: "var(--radius-md)",
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
  },
};

export type GlobalSearchDialogProps = {
  /** The active space to search within (messages and file names). */
  spaceId: string;
  /** Directory of members, filtered client-side (there is no people-search endpoint). */
  people: { name: string; presence: Presence; bot?: boolean }[];
  onClose: () => void;
  onOpenMessage: (channelId: string, messageId: string) => void;
  onOpenFile: () => void;
  onOpenProfile: (name: string) => void;
};

/** Workspace-wide search across messages, files (API) and people (local directory). */
export function GlobalSearchDialog({
  spaceId,
  people,
  onClose,
  onOpenMessage,
  onOpenFile,
  onOpenProfile,
}: GlobalSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [msgHits, setMsgHits] = useState<SearchMessage[]>([]);
  const [fileHits, setFileHits] = useState<FileHit[]>([]);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim();

  // Debounced API search; a new keystroke cancels the in-flight request. Resetting results and the
  // loading flag as the query changes is the intended synchronization here.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!q) {
      setMsgHits([]);
      setFileHits([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const handle = setTimeout(() => {
      search(spaceId, q, controller.signal)
        .then((hits) => {
          setMsgHits(hits.messages.slice(0, 8));
          setFileHits(hits.files.slice(0, 6));
          setLoading(false);
        })
        .catch(() => {
          // Ignore an aborted or failed search; keep the last results rather than flashing empty.
          setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [q, spaceId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const peopleHits = useMemo(
    () => (q ? people.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 6) : []),
    [q, people],
  );
  const total = msgHits.length + fileHits.length + peopleHits.length;

  // Flat list of open actions, in display order (messages, then files, then people), so the arrow
  // keys move across every group. The group offsets below map a row back to its global index.
  const actions = useMemo<(() => void)[]>(
    () => [
      ...msgHits.map((m) => () => onOpenMessage(m.conversationId, m.id)),
      ...fileHits.map(() => onOpenFile),
      ...peopleHits.map((p) => () => onOpenProfile(p.name)),
    ],
    [msgHits, fileHits, peopleHits, onOpenMessage, onOpenFile, onOpenProfile],
  );
  const fileStart = msgHits.length;
  const peopleStart = msgHits.length + fileHits.length;

  const rowStyle = (idx: number): CSSProperties => ({
    ...styles.row,
    background: idx === active ? "var(--surface-selected)" : "transparent",
  });
  const scrollTo = (i: number) => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${i}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(total - 1, active + 1);
      setActive(next);
      scrollTo(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, active - 1);
      setActive(next);
      scrollTo(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      actions[active]?.();
    }
  };

  return (
    <Dialog title="Rechercher partout" size="md" onClose={onClose}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-md)",
          marginBottom: 4,
        }}
      >
        <Icon name="search" size={16} style={{ color: "var(--text-subtle)" }} />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          aria-label="Rechercher dans tout l'espace"
          placeholder="Messages, fichiers, personnes dans tout l'espace…"
          style={{
            flex: 1,
            border: 0,
            outline: "none",
            background: "none",
            fontFamily: "inherit",
            fontSize: 14,
            color: "var(--text-strong)",
          }}
        />
      </div>

      <div ref={listRef} style={{ maxHeight: 360, overflow: "auto" }}>
        {!q ? (
          <EmptyState
            size="compact"
            icon="search"
            description="Tapez pour chercher dans les canaux, les fichiers et l'annuaire."
          />
        ) : total === 0 ? (
          <EmptyState
            size="compact"
            icon="search"
            title={loading ? "Recherche…" : "Aucun résultat"}
            description={loading ? "Interrogation du serveur." : `Rien ne correspond à « ${query} ».`}
          />
        ) : (
          <>
            {msgHits.length > 0 ? (
              <>
                <div style={styles.label}>Messages</div>
                {msgHits.map((m, i) => (
                  <button
                    key={`${m.conversationId}:${m.id}`}
                    type="button"
                    className="wc-listrow"
                    data-idx={i}
                    style={rowStyle(i)}
                    onMouseMove={() => setActive(i)}
                    onClick={() => onOpenMessage(m.conversationId, m.id)}
                  >
                    <Avatar name={m.author} src={getAvatar(m.author)} size={26} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
                        {m.author}
                        <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>{m.time}</span>
                      </span>
                      <span
                        style={{
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                          fontSize: 13,
                          color: "var(--text-body)",
                        }}
                      >
                        {messageSummary(m)}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            ) : null}

            {fileHits.length > 0 ? (
              <>
                <div style={styles.label}>Fichiers</div>
                {fileHits.map((f, i) => (
                  <button
                    key={f.id}
                    type="button"
                    className="wc-listrow"
                    data-idx={fileStart + i}
                    style={rowStyle(fileStart + i)}
                    onMouseMove={() => setActive(fileStart + i)}
                    onClick={onOpenFile}
                  >
                    <Icon name={f.kind === "folder" ? "folder" : "file"} size={18} style={{ color: "var(--text-muted)", marginTop: 1 }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13, color: "var(--text-strong)" }}>{f.name}</span>
                    </span>
                  </button>
                ))}
              </>
            ) : null}

            {peopleHits.length > 0 ? (
              <>
                <div style={styles.label}>Personnes</div>
                {peopleHits.map((p, i) => (
                  <button
                    key={p.name}
                    type="button"
                    className="wc-listrow"
                    data-idx={peopleStart + i}
                    style={rowStyle(peopleStart + i)}
                    onMouseMove={() => setActive(peopleStart + i)}
                    onClick={() => onOpenProfile(p.name)}
                  >
                    <Avatar name={p.name} src={getAvatar(p.name)} size={26} presence={p.presence} kind={p.bot ? "bot" : "person"} />
                    <span style={{ fontSize: 13, color: "var(--text-strong)", alignSelf: "center" }}>{p.name}</span>
                  </button>
                ))}
              </>
            ) : null}
          </>
        )}
      </div>
      {total > 0 ? (
        <div style={{ display: "flex", gap: 14, padding: "8px 2px 0", fontSize: 11, color: "var(--text-subtle)" }}>
          <span>↑ ↓ pour naviguer</span>
          <span>Entrée pour ouvrir</span>
          <span>Échap pour fermer</span>
        </div>
      ) : null}
    </Dialog>
  );
}
