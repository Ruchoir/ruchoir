"use client";

import { type CSSProperties, useEffect, useRef } from "react";
import { Avatar, EmptyState, Icon, IconButton, Tag } from "@/components/ds";
import { getAvatar, getPresence } from "@/lib/data";
import type { DirectMessage, Message, SpaceFile } from "@/lib/data";
import { messageSummary } from "@/features/app/activity";
import { useTranslation } from "@/lib/i18n";

const styles: Record<string, CSSProperties> = {
  panel: {
    width: "var(--panel-width)",
    flex: "none",
    borderLeft: "1px solid var(--border-subtle)",
    background: "var(--surface-chrome)",
    display: "flex",
    flexDirection: "column",
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
  row: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 16px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  memberRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    padding: "8px 16px",
    border: 0,
    borderBottom: "1px solid var(--border-subtle)",
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "var(--font-sans)",
  },
};

export type ChannelMember = Pick<DirectMessage, "id" | "name" | "presence" | "bot"> & {
  /** The member's uploaded avatar; absent falls back to the one generated from their name. */
  avatar?: string;
};

const TITLES: Record<SidePanelKind, string> = {
  files: "Fichiers du canal",
  members: "Membres du canal",
  pinned: "Messages épinglés",
};

export type SidePanelKind = "files" | "members" | "pinned";

export type SidePanelProps = {
  kind: SidePanelKind;
  files: SpaceFile[];
  members: ChannelMember[];
  pinned: Message[];
  highlightFile?: string | null;
  onClose: () => void;
  onSelectMember: (name: string) => void;
  onJump: (messageId: string) => void;
  onNotify: (toast: import("../app/types").Toast) => void;
};

/** Right-hand panel of the channel: file, member, or pinned-message list. */
export function SidePanel({ kind, files, members, pinned, highlightFile, onClose, onSelectMember, onJump, onNotify }: SidePanelProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  // When asked to jump to a file, scroll it into view and flash it (after the panel mounts).
  useEffect(() => {
    if (kind !== "files" || !highlightFile) return;
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-file="${CSS.escape(highlightFile)}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("wc-flash");
      void el.offsetWidth;
      el.classList.add("wc-flash");
    });
    return () => cancelAnimationFrame(raf);
  }, [kind, highlightFile]);

  return (
    <div style={styles.panel}>
      <div style={styles.head}>
        <span style={styles.title}>{TITLES[kind]}</span>
        <IconButton icon="x" label="Fermer le panneau" size="sm" onClick={onClose} />
      </div>
      <div style={{ flex: 1, overflow: "auto" }} ref={scrollRef}>
        {kind === "files"
          ? files.map((fl) => (
              <div key={fl.name} data-file={fl.name} style={styles.row}>
                <Icon name={fl.kind} size={18} style={{ color: "var(--text-muted)" }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {fl.name}
                  </span>
                  <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                    {fl.size} · {fl.when}
                  </span>
                </span>
                {fl.source !== "Ruchoir" ? <Tag>{fl.source}</Tag> : null}
                <IconButton
                  icon={fl.kind === "folder" ? "folder-open" : "download"}
                  label={fl.kind === "folder" ? "Ouvrir le dossier" : "Télécharger"}
                  size="sm"
                  onClick={() =>
                    onNotify({
                      tone: "info",
                      title: fl.kind === "folder" ? "Ouverture du dossier" : "Téléchargement",
                      description: fl.name,
                    })
                  }
                />
              </div>
            ))
          : null}

        {kind === "members"
          ? members.map((p) => (
              <button
                key={p.id}
                style={styles.memberRow}
                onClick={() => onSelectMember(p.name)}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <Avatar name={p.name} src={p.avatar} size={30} presence={p.presence} kind={p.bot ? "bot" : "person"} shape={p.bot ? "round" : "square"} />
                <span style={{ flex: 1, fontSize: 14, color: "var(--text-strong)" }}>{p.name}</span>
                {p.bot ? <Tag>Bot</Tag> : null}
              </button>
            ))
          : null}

        {kind === "pinned"
          ? pinned.length === 0
            ? (
                <EmptyState
                  size="compact"
                  icon="pin"
                  title="Aucun message épinglé"
                  description="Épinglez un message depuis son menu pour le retrouver ici."
                />
              )
            : pinned.map((m) => (
                <div
                  key={m.id}
                  style={{ ...styles.row, alignItems: "flex-start", padding: "10px 16px", cursor: "pointer" }}
                  onClick={() => onJump(m.id)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <Avatar name={m.author} src={getAvatar(m.author)} size={28} presence={getPresence(m.author)} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
                      {m.author}
                      <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>{m.time}</span>
                    </span>
                    <span style={{ display: "block", fontSize: 13, color: "var(--text-body)", lineHeight: "var(--leading-snug)", marginTop: 2, textWrap: "pretty" }}>
                      {messageSummary(m) ?? t("activity.attachment")}
                    </span>
                    {m.image?.src ? (
                      // A pinned photograph is pinned for what it shows. The row is already
                      // multi-line and carries attachment rows, so there is space for the thing
                      // itself rather than a word describing it.
                      // eslint-disable-next-line @next/next/no-img-element -- same-origin, served by the API
                      <img
                        src={m.image.src}
                        alt={m.image.alt}
                        style={{
                          display: "block",
                          marginTop: 6,
                          maxWidth: "100%",
                          maxHeight: 96,
                          borderRadius: "var(--radius-sm)",
                          border: "1px solid var(--border-subtle)",
                        }}
                      />
                    ) : null}
                    {m.link ? (
                      <a
                        href={m.link.url}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onNotify({ tone: "info", title: "Ouverture du lien", description: m.link?.domain });
                        }}
                        style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 12, color: "var(--text-link)" }}
                      >
                        <Icon name="globe" size={13} />
                        {m.link.domain}
                      </a>
                    ) : null}
                    {m.attachment ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onNotify({ tone: "info", title: "Téléchargement", description: m.attachment?.name });
                        }}
                        style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 6, border: 0, background: "none", padding: 0, cursor: "pointer", fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--text-link)" }}
                      >
                        <Icon name="download" size={14} />
                        {m.attachment.name}
                      </button>
                    ) : null}
                  </span>
                </div>
              ))
          : null}
      </div>
    </div>
  );
}
