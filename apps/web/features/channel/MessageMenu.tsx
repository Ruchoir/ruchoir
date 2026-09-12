"use client";

import { type CSSProperties, useRef, useState } from "react";
import { Icon, IconButton, Popover } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";

const menu: CSSProperties = {
  minWidth: 208,
  padding: 4,
  background: "var(--surface-canvas)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-popover)",
};

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 8px",
  border: 0,
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--text-body)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  textAlign: "left",
  cursor: "pointer",
};

type Item = { icon: string; label: string; onClick: () => void; danger?: boolean };

export type MessageMenuProps = {
  pinned?: boolean;
  own?: boolean;
  /** When the message was sent, already formatted in the reader's language. */
  sentAt: string;
  /** Whether the message carries reactions (shows the "see reactions" entry). */
  hasReactions?: boolean;
  /** Open the reactions list (who reacted with what). */
  onShowReactions?: () => void;
  onEdit: () => void;
  onCopyMessage: () => void;
  onCopyLink: () => void;
  onTogglePin: () => void;
  onMarkUnread: () => void;
  onDelete: () => void;
  /** Notified when the menu opens/closes, so a hover-gated container can stay mounted. */
  onOpenChange?: (open: boolean) => void;
};

/** The three-dots message context menu, positioned with a viewport-aware popover. */
export function MessageMenu({
  pinned,
  own,
  sentAt,
  hasReactions,
  onShowReactions,
  onEdit,
  onCopyMessage,
  onCopyLink,
  onTogglePin,
  onMarkUnread,
  onDelete,
  onOpenChange,
}: MessageMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const set = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const run = (fn: () => void) => {
    fn();
    set(false);
  };

  const items: Item[] = [
    ...(hasReactions && onShowReactions
      ? [{ icon: "smile", label: t("message.viewReactions"), onClick: onShowReactions }]
      : []),
    ...(own ? [{ icon: "square-pen", label: t("message.editMessage"), onClick: onEdit }] : []),
    { icon: "copy", label: t("message.copyMessage"), onClick: onCopyMessage },
    { icon: "paperclip", label: t("message.copyLink"), onClick: onCopyLink },
    { icon: "inbox", label: t("message.markUnread"), onClick: onMarkUnread },
    { icon: "pin", label: pinned ? t("message.unpin") : t("message.pin"), onClick: onTogglePin },
    ...(own ? [{ icon: "trash-2", label: t("message.deleteMessage"), onClick: onDelete, danger: true }] : []),
  ];

  return (
    <>
      <IconButton
        ref={anchorRef}
        icon="more-horizontal"
        label={t("message.more")}
        size="sm"
        aria-expanded={open}
        onClick={() => set(!open)}
      />
      <Popover anchorRef={anchorRef} open={open} onClose={() => set(false)} placement="bottom" align="end">
        <div style={menu} role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => run(it.onClick)}
              style={{ ...itemStyle, color: it.danger ? "var(--status-danger-fg)" : "var(--text-body)" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <Icon name={it.icon} size={14} />
              {it.label}
            </button>
          ))}
          <div style={{ height: 1, background: "var(--border-subtle)", margin: "4px 0" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", fontSize: 12, color: "var(--text-subtle)" }}>
            <Icon name="clock" size={14} />
            {t("message.sentAt", { at: sentAt })}
          </div>
        </div>
      </Popover>
    </>
  );
}
