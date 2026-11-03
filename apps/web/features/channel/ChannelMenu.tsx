"use client";

import { type CSSProperties, useRef, useState } from "react";
import { Icon, IconButton, Popover, Tooltip } from "@/components/ds";
import type { Channel } from "@/lib/data";
import { useTranslation } from "@/lib/i18n";
import { type ChannelMenuActions, channelMenuItems } from "./channelMenuItems";

const menu: CSSProperties = {
  minWidth: 220,
  padding: 4,
  background: "var(--surface-raised)",
  border: "var(--edge-width) solid var(--edge-float)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-popover)",
};

const itemStyle: CSSProperties = {
  display: "flex",
  transition: "background-color var(--duration-fast) var(--ease-out)",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 8px",
  border: 0,
  borderRadius: "var(--radius-item)",
  background: "transparent",
  color: "var(--text-body)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  textAlign: "left",
  cursor: "pointer",
};

/**
 * The header shows the channel already open, so it leaves out what belongs to the channel list:
 * marking it read (opening it does that), making it the default and moving it in the list.
 */
type HeaderActions = Omit<ChannelMenuActions, "onAddPeople" | "onMarkRead" | "onSetDefault" | "onMoveUp" | "onMoveDown">;

export type ChannelMenuProps = HeaderActions & {
  onAddPeople: () => void;
  /**
   * Whether the caller moderates this channel. Deciding who is in it is moderation, so the entry is
   * not offered to someone the API would refuse: they are in the channel, which is not the same
   * thing as deciding who else is.
   */
  canModerate: boolean;
  /** The channel, for the favourite and membership entries. */
  channel: Pick<Channel, "fav" | "member">;
};

/** The channel header three-dots menu. */
export function ChannelMenu({ canModerate, channel, onAddPeople, ...actions }: ChannelMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const run = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  // The sidebar's recipe, so the entries both menus share keep the same order and icons.
  const items = channelMenuItems(t, channel, { ...actions, onAddPeople: canModerate ? onAddPeople : undefined });

  return (
    <>
      <Tooltip label={t("message.more")} disabled={open}>
        <IconButton
          ref={anchorRef}
          className="wc-ibtn--bare"
          icon="more-horizontal"
          label={t("message.more")}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        />
      </Tooltip>
      <Popover anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} placement="bottom" align="end">
        <div className="wc-float" style={menu} role="menu">
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
