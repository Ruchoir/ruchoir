"use client";

import { type CSSProperties, useRef, useState } from "react";
import { Icon, IconButton, Popover } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";

const menu: CSSProperties = {
  minWidth: 220,
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

export type ChannelMenuProps = {
  onSettings: () => void;
  onNotifications: () => void;
  onAddPeople: () => void;
  onLeave: () => void;
  /** Rejoin a public channel the user had left. */
  onJoin: () => void;
  /** Whether the user has joined this channel; a public one is readable either way. */
  member?: boolean;
};

/** The channel header three-dots menu. */
export function ChannelMenu({
  onSettings,
  onNotifications,
  onAddPeople,
  onLeave,
  onJoin,
  member = true,
}: ChannelMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const run = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  const items: Item[] = [
    { icon: "settings", label: t("sidebar.channelSettings"), onClick: onSettings },
    { icon: "inbox", label: t("notif.title"), onClick: onNotifications },
    { icon: "user-plus", label: t("channel.addPeople"), onClick: onAddPeople },
    // Leaving a public channel is reversible, so the entry flips to rejoining instead of vanishing.
    member
      ? { icon: "arrow-left", label: t("sidebar.leaveChannel"), onClick: onLeave, danger: true }
      : { icon: "user-plus", label: t("sidebar.joinChannel"), onClick: onJoin },
  ];

  return (
    <>
      <IconButton
        ref={anchorRef}
        className="wc-ibtn--bare"
        icon="more-horizontal"
        label={t("message.more")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      <Popover anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} placement="bottom" align="end">
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
        </div>
      </Popover>
    </>
  );
}
