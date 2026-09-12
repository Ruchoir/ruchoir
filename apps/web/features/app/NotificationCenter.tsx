"use client";

import { type CSSProperties, type RefObject, useState } from "react";
import { Avatar, EmptyState, Icon, IconButton, Popover, Tabs } from "@/components/ds";
import { getAvatar, getPresence } from "@/lib/data";
import { type AppNotification, isMention, type NotifKind, notifSummary } from "./notifications";
import { useTranslation } from "@/lib/i18n";

const KIND_ICON: Record<NotifKind, string> = {
  mention: "at-sign",
  // Told apart from a mention by name at a glance, which is the whole point of the two being
  // different kinds: one person typed your name, or everyone in the channel got this.
  broadcast: "users",
  reply: "message-square",
  dm: "mail",
};

const styles: Record<string, CSSProperties> = {
  panel: {
    width: "min(380px, calc(var(--ui-vw, 100vw) - 24px))",
    maxHeight: "min(560px, calc(0.8 * var(--ui-vh, 100dvh)))",
    display: "flex",
    flexDirection: "column",
    background: "var(--surface-canvas)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-popover)",
    overflow: "hidden",
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "12px 10px 12px 16px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  title: { fontSize: 15, fontWeight: 600, color: "var(--text-strong)" },
  filters: { padding: "8px 12px", borderBottom: "1px solid var(--border-subtle)" },
  scroll: { flex: 1, overflow: "auto", padding: 6 },
  row: {
    display: "flex",
    gap: 10,
    width: "100%",
    padding: "10px 10px",
    border: 0,
    borderRadius: "var(--radius-md)",
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
  },
  foot: {
    flex: "none",
    display: "flex",
    justifyContent: "center",
    padding: 6,
    borderTop: "1px solid var(--border-subtle)",
  },
};

type Filter = "all" | "unread" | "mentions";

/** Empty-state copy per filter, as dictionary keys. */
const EMPTY: Record<Filter, { title: string; text: string }> = {
  all: { title: "notif.nothingNew", text: "notif.nothingNewText" },
  unread: { title: "notif.allRead", text: "notif.allReadText" },
  mentions: { title: "activity.mentionsEmptyTitle", text: "activity.mentionsEmptyText" },
};

export type NotificationCenterProps = {
  anchorRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onClose: () => void;
  /** Notifications already filtered by the channel and global preferences. */
  notifications: AppNotification[];
  onOpen: (channelId: string, messageId: string, id: string) => void;
  onToggleRead: (id: string, read: boolean) => void;
  onMarkAllRead: () => void;
  onOpenPrefs: () => void;
};

/** Floating inbox of recent notifications, anchored to the sidebar bell. */
export function NotificationCenter({
  anchorRef,
  open,
  onClose,
  notifications,
  onOpen,
  onToggleRead,
  onMarkAllRead,
  onOpenPrefs,
}: NotificationCenterProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("all");
  const unread = notifications.filter((n) => !n.read).length;

  const rows =
    filter === "unread"
      ? notifications.filter((n) => !n.read)
      : filter === "mentions"
        ? notifications.filter((n) => isMention(n.kind))
        : notifications;

  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} placement="bottom" align="start">
      <div style={styles.panel} role="dialog" aria-label={t("notif.title")}>
        <div style={styles.head}>
          <span style={styles.title}>{t("notif.title")}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <IconButton
              icon="check-check"
              label={t("notif.markAllRead")}
              size="sm"
              disabled={unread === 0}
              onClick={onMarkAllRead}
            />
            <IconButton icon="settings" label={t("notif.preferences")} size="sm" onClick={onOpenPrefs} />
          </span>
        </div>

        <div style={styles.filters}>
          <Tabs
            variant="pills"
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            items={[
              { value: "all", label: t("notif.all") },
              { value: "unread", label: t("notif.unread"), count: unread || undefined },
              { value: "mentions", label: t("activity.mentions") },
            ]}
          />
        </div>

        {rows.length === 0 ? (
          <EmptyState
            size="compact"
            icon={filter === "mentions" ? "at-sign" : filter === "unread" ? "check-check" : "bell"}
            title={t(EMPTY[filter].title)}
            description={t(EMPTY[filter].text)}
          />
        ) : (
          <div style={styles.scroll}>
            {rows.map((n) => (
              <NotifRow key={n.id} notif={n} onOpen={onOpen} onToggleRead={onToggleRead} />
            ))}
          </div>
        )}

        {notifications.length > 0 ? (
          <div style={styles.foot}>
            <button
              type="button"
              onClick={onOpenPrefs}
              style={{
                border: 0,
                background: "none",
                cursor: "pointer",
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                color: "var(--text-muted)",
                padding: "4px 8px",
              }}
            >
              Gérer les préférences de notification
            </button>
          </div>
        ) : null}
      </div>
    </Popover>
  );
}

function NotifRow({
  notif,
  onOpen,
  onToggleRead,
}: {
  notif: AppNotification;
  onOpen: (channelId: string, messageId: string, id: string) => void;
  onToggleRead: (id: string, read: boolean) => void;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(notif.channelId, notif.messageId, notif.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(notif.channelId, notif.messageId, notif.id);
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...styles.row, background: hover ? "var(--surface-hover)" : "transparent" }}
    >
      {/* Unread rail: a filled dot for unread, an invisible spacer for read, so rows stay aligned. */}
      <span
        aria-hidden
        style={{
          flex: "none",
          width: 8,
          marginTop: 15,
          height: 8,
          borderRadius: "var(--radius-full)",
          background: notif.read ? "transparent" : "var(--action-primary-bg)",
        }}
      />
      <span style={{ position: "relative", flex: "none" }}>
        <Avatar name={notif.actor} src={getAvatar(notif.actor)} size={32} presence={getPresence(notif.actor)} />
        <span
          aria-hidden
          style={{
            position: "absolute",
            right: -3,
            bottom: -3,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            height: 16,
            borderRadius: "var(--radius-full)",
            background: "var(--surface-canvas)",
            color: "var(--text-muted)",
          }}
        >
          <Icon name={KIND_ICON[notif.kind]} size={11} />
        </span>
      </span>

      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 2 }}>
          <span style={{ fontSize: 13, fontWeight: notif.read ? 500 : 600, color: "var(--text-strong)", minWidth: 0 }}>
            {notifSummary(notif, t)}
          </span>
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
          {notif.preview}
        </span>
        <span style={{ display: "block", marginTop: 3, fontSize: 11, color: "var(--text-muted)" }}>
          {notif.label} · {notif.time}
        </span>
      </span>

      <IconButton
        icon={notif.read ? "bell" : "check"}
        label={notif.read ? "Marquer comme non lu" : "Marquer comme lu"}
        size="sm"
        tabIndex={hover ? 0 : -1}
        aria-hidden={!hover}
        onClick={(e) => {
          e.stopPropagation();
          onToggleRead(notif.id, !notif.read);
        }}
        style={{
          flex: "none",
          opacity: hover ? 1 : 0,
          pointerEvents: hover ? "auto" : "none",
          transition: "opacity var(--duration-fast) var(--ease-out)",
        }}
      />
    </div>
  );
}
