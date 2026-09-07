"use client";

import type { CSSProperties } from "react";
import { Avatar, EmptyState, Icon, Tag } from "@/components/ds";
import { getAvatar, getPresence } from "@/lib/data";
import { type ActivityItem, messageSummary } from "./activity";

export type ActivityKind = "threads" | "mentions" | "saved";

const META: Record<ActivityKind, { icon: string; title: string; emptyTitle: string; emptyText: string }> = {
  threads: {
    icon: "inbox",
    title: "Fils",
    emptyTitle: "Aucun fil en attente",
    emptyText: "Les fils auxquels vous participez apparaissent ici, les plus récents d'abord.",
  },
  mentions: {
    icon: "at-sign",
    title: "Mentions",
    emptyTitle: "Aucune mention",
    emptyText: "Quand quelqu'un vous mentionne avec @, le message apparaît ici.",
  },
  saved: {
    icon: "bookmark",
    title: "Enregistrés",
    emptyTitle: "Rien d'enregistré",
    emptyText: "Enregistrez un message depuis ses actions au survol pour le retrouver ici.",
  },
};

const styles: Record<string, CSSProperties> = {
  root: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 },
  top: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 16px",
    margin: 0, // rendered as an <h1>
    borderBottom: "1px solid var(--border-subtle)",
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: "var(--tracking-tight)",
    color: "var(--text-strong)",
  },
  scroll: { flex: 1, overflow: "auto", padding: "18px 0" },
  inner: { maxWidth: 720, margin: "0 auto", padding: "0 24px", display: "flex", flexDirection: "column", gap: 10 },
  item: {
    display: "flex",
    gap: 12,
    width: "100%",
    padding: "12px 14px",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    background: "var(--surface-canvas)",
    cursor: "pointer",
    textAlign: "left",
  },
  empty: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center" },
};

export type ActivityViewProps = {
  kind: ActivityKind;
  items: ActivityItem[];
  onOpen: (channelId: string, messageId: string) => void;
};

/** Filtered cross-channel list for the Threads, Mentions and Saved views. */
export function ActivityView({ kind, items, onOpen }: ActivityViewProps) {
  const meta = META[kind];

  return (
    <div style={styles.root}>
      <h1 style={styles.top}>
        <Icon name={meta.icon} size={15} style={{ color: "var(--text-muted)" }} />
        {meta.title}
        {items.length > 0 ? (
          <span style={{ fontSize: 13, fontWeight: 400, color: "var(--text-muted)" }}>· {items.length}</span>
        ) : null}
      </h1>

      {items.length === 0 ? (
        <div style={styles.empty}>
          <EmptyState icon={meta.icon} title={meta.emptyTitle} description={meta.emptyText} />
        </div>
      ) : (
        <div style={styles.scroll}>
          <div style={styles.inner}>
            {items.map((it) => (
              <button
                key={`${it.channelId}:${it.message.id}`}
                type="button"
                style={styles.item}
                className="wc-listrow"
                onClick={() => onOpen(it.channelId, it.message.id)}
              >
                <Avatar name={it.message.author} src={getAvatar(it.message.author)} size={30} presence={getPresence(it.message.author)} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-strong)" }}>{it.message.author}</span>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {it.label} · {it.message.time}
                    </span>
                    {kind === "saved" ? <Icon name="bookmark" size={13} style={{ color: "var(--terracotta-500)" }} /> : null}
                  </span>
                  <span
                    style={{
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                      fontSize: 14,
                      color: "var(--text-body)",
                    }}
                  >
                    {messageSummary(it.message)}
                  </span>
                  {kind === "threads" && it.message.replies ? (
                    <span style={{ display: "inline-flex", marginTop: 8 }}>
                      <Tag tone="accent" icon="message-square">
                        {it.message.replies} réponse{it.message.replies > 1 ? "s" : ""}
                      </Tag>
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
