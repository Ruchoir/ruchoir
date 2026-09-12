"use client";

import { type CSSProperties, useMemo, useState } from "react";
import { Avatar, EmptyState, Icon, IconButton, Input } from "@/components/ds";
import { getAvatar, getPresence } from "@/lib/data";
import type { Message, SpaceFile } from "@/lib/data";
import { messageSummary } from "@/features/app/activity";
import { useTranslation } from "@/lib/i18n";
import { formatBytes, formatStamp } from "@/lib/i18n/format";

const styles: Record<string, CSSProperties> = {
  panel: {
    width: "var(--panel-width)",
    flex: "none",
    borderLeft: "1px solid var(--border-subtle)",
    background: "var(--surface-chrome)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  head: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px 0 16px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  title: { fontSize: 14, fontWeight: 600, color: "var(--text-strong)" },
  search: { padding: 12, borderBottom: "1px solid var(--border-subtle)" },
  scroll: { flex: 1, overflow: "auto" },
  label: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
    padding: "12px 16px 4px",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    width: "100%",
    padding: "8px 16px",
    border: 0,
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "var(--font-sans)",
  },
};

export type SearchPanelProps = {
  messages: Message[];
  files: SpaceFile[];
  onClose: () => void;
  onJump: (messageId: string) => void;
  onJumpFile: (fileName: string) => void;
};

/** In-channel search over messages and files (mock filter over the loaded channel data). */
export function SearchPanel({ messages, files, onClose, onJump, onJumpFile }: SearchPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const msgHits = useMemo(
    () =>
      q
        ? messages.filter(
            (m) => !m.deleted && (m.body.toLowerCase().includes(q) || m.author.toLowerCase().includes(q)),
          )
        : [],
    [q, messages],
  );
  const fileHits = useMemo(() => (q ? files.filter((f) => f.name.toLowerCase().includes(q)) : []), [q, files]);
  const total = msgHits.length + fileHits.length;

  return (
    <div style={styles.panel}>
      <div style={styles.head}>
        <span style={styles.title}>{t("common.search")}</span>
        <IconButton icon="x" label={t("search.close")} size="sm" onClick={onClose} />
      </div>
      <div style={styles.search}>
        <Input
          icon="search"
          placeholder={t("search.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>
      <div style={styles.scroll}>
        {!q ? (
          <EmptyState size="compact" icon="search" description={t("search.prompt")} />
        ) : total === 0 ? (
          <EmptyState size="compact" icon="search" title={t("search.noResult")} description={t("search.noMessageOrFile", { query })} />
        ) : (
          <>
            {msgHits.length > 0 ? (
              <>
                <div style={styles.label}>{t("search.messagesCount", { count: msgHits.length })}</div>
                {msgHits.map((m) => (
                  <button
                    key={m.id}
                    style={styles.row}
                    onClick={() => onJump(m.id)}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <Avatar name={m.author} src={getAvatar(m.author)} size={26} presence={getPresence(m.author)} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
                        {m.author}
                        <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>{formatStamp(m.createdAt)}</span>
                      </span>
                      <span style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", fontSize: 13, color: "var(--text-body)" }}>
                        {messageSummary(m) ?? t("activity.attachment")}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            ) : null}
            {fileHits.length > 0 ? (
              <>
                <div style={styles.label}>{t("search.filesCount", { count: fileHits.length })}</div>
                {fileHits.map((f) => (
                  <button
                    key={f.name}
                    style={styles.row}
                    onClick={() => onJumpFile(f.name)}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <Icon name={f.kind} size={18} style={{ color: "var(--text-muted)", marginTop: 1 }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {f.name}
                      </span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                        {f.kind === "folder" ? "" : `${formatBytes(f.sizeBytes)} · `}
                        {formatStamp(f.updatedAt)}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
