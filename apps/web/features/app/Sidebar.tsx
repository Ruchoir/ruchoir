"use client";

import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { Avatar, Badge, Icon, IconButton, Input, Popover, Tag } from "@/components/ds";
import type { Channel, DirectMessage, Workspace } from "@/lib/data";
import { MenuPopover } from "./MenuPopover";
import { NotificationCenter } from "./NotificationCenter";
import type { AppNotification, ChannelNotifPref } from "./notifications";
import type { AppView, Toast } from "./types";
import { Wordmark } from "./Wordmark";
import { getAvatar } from "@/lib/data";
import { useTranslation } from "@/lib/i18n";

const styles: Record<string, CSSProperties> = {
  side: {
    width: "var(--sidebar-width)",
    flex: "none",
    background: "var(--surface-chrome)",
    borderRight: "1px solid var(--border-subtle)",
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
    padding: "0 8px 0 12px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  wsName: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    border: 0,
    background: "none",
    padding: "4px 6px",
    marginLeft: -6,
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: "var(--tracking-tight)",
    color: "var(--text-strong)",
  },
  scroll: { flex: 1, overflow: "auto", padding: "8px 8px 16px" },
  empty: {
    margin: "2px 6px 4px",
    fontSize: 12,
    lineHeight: "var(--leading-snug)",
    color: "var(--text-subtle)",
  },
  sect: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 6px 4px",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
  },
  name: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
};

function item(on: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    height: 32,
    padding: "0 8px",
    border: 0,
    borderRadius: "var(--radius-sm)",
    background: on ? "var(--surface-selected)" : "transparent",
    color: on ? "var(--text-accent)" : "var(--text-body)",
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    fontSize: 14,
    fontWeight: on ? 600 : 400,
    textAlign: "left",
    // Active row: a solid left accent bar (drawn with an inset shadow so it adds no layout width).
    // A shape cue on top of the colour so the active channel is legible even where the pale selected
    // surface has low contrast against the canvas.
    boxShadow: on ? "inset 3px 0 0 0 var(--border-accent)" : undefined,
  };
}

export type SideMenuItem = { icon: string; label: string; onClick: () => void; danger?: boolean };

const menuStyle: CSSProperties = {
  minWidth: 200,
  padding: 4,
  background: "var(--surface-canvas)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-popover)",
};

const menuItemStyle: CSSProperties = {
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

type SideItemProps = {
  icon?: string;
  label: string;
  active?: boolean;
  unread?: number;
  muted?: boolean;
  /** Notifications silenced (muted or level "none"): shows a bell-off and dims the unread badge. */
  notifMuted?: boolean;
  tag?: ReactNode;
  onClick?: () => void;
  children?: ReactNode;
  menuItems?: SideMenuItem[];
};

function SideItem({ icon, label, active, unread, muted, notifMuted, tag, onClick, children, menuItems }: SideItemProps) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  // Active fill: a clearly visible terracotta tint (the token --surface-selected is too pale on the
  // cream canvas to read). Mixed over transparent so it tints correctly in both light and dark themes.
  const bg = active
    ? "color-mix(in srgb, var(--border-accent) 16%, transparent)"
    : hover || menuOpen
      ? "var(--surface-hover)"
      : "transparent";
  const showMore = !!menuItems && menuItems.length > 0 && (hover || menuOpen);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...item(!!active), background: bg }}
    >
      {children ?? <Icon name={icon ?? "hash"} size={14} style={{ color: muted ? "var(--text-subtle)" : "var(--text-muted)" }} />}
      <span
        style={{
          ...styles.name,
          fontWeight: unread ? 500 : undefined,
          // De-emphasise muted (archived) channels with a token, not opacity, so contrast stays measurable.
          color: unread ? "var(--text-strong)" : muted ? "var(--text-subtle)" : undefined,
        }}
      >
        {label}
      </span>
      {tag}
      {notifMuted ? (
        <Icon name="bell-off" size={13} title={t("sidebar.muted")} style={{ flex: "none", color: "var(--text-subtle)" }} />
      ) : null}
      {menuItems && menuItems.length > 0 ? (
        // Fixed-width slot: the more-button is always mounted (opacity toggled) so the popover anchor
        // never moves as hover changes, and the unread badge shows underneath when it is hidden.
        <span style={{ position: "relative", flex: "none", width: 24, height: 20, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
          {!showMore && unread ? <Badge count={unread} tone={notifMuted ? "neutral" : "accent"} /> : null}
          <IconButton
            ref={moreRef}
            icon="more-horizontal"
            label={t("sidebar.actionsFor", { name: label })}
            size="sm"
            tabIndex={showMore ? 0 : -1}
            aria-hidden={!showMore}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
            style={{
              position: "absolute",
              right: 0,
              opacity: showMore ? 1 : 0,
              pointerEvents: showMore ? "auto" : "none",
              transition: "opacity var(--duration-fast) var(--ease-out)",
            }}
          />
          <Popover anchorRef={moreRef} open={menuOpen} onClose={() => setMenuOpen(false)} placement="bottom" align="end">
            <div style={menuStyle} role="menu" onClick={(e) => e.stopPropagation()}>
              {menuItems.map((mi) => (
                <button
                  key={mi.label}
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    mi.onClick();
                    setMenuOpen(false);
                  }}
                  style={{ ...menuItemStyle, color: mi.danger ? "var(--status-danger-fg)" : "var(--text-body)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <Icon name={mi.icon} size={14} />
                  {mi.label}
                </button>
              ))}
            </div>
          </Popover>
        </span>
      ) : unread ? (
        <Badge count={unread} tone={notifMuted ? "neutral" : "accent"} />
      ) : null}
    </div>
  );
}

export type SidebarProps = {
  workspace: Workspace | undefined;
  channels: Channel[];
  directMessages: DirectMessage[];
  /** Take a direct conversation out of the list until it has a new message. */
  onHideDm: (id: string) => void;
  view: AppView;
  channel: string;
  mentionCount: number;
  /** Per-conversation notification preferences, keyed by channel/DM id. */
  channelPrefs: Record<string, ChannelNotifPref>;
  /** Notifications already filtered by the channel and global preferences. */
  notifications: AppNotification[];
  /** Unread count among the visible notifications (drives the bell badge). */
  notifUnread: number;
  onView: (view: AppView) => void;
  onChannel: (id: string) => void;
  onNotify: (toast: Toast) => void;
  onInvite: () => void;
  onNewChannel: () => void;
  /**
   * Whether the caller reaches the space at large: its files, a new channel, an invitation. False
   * for a guest, who is in the space only through the conversations they were added to. The API
   * refuses all three either way; this keeps the column from offering them.
   */
  canBrowseSpace: boolean;
  onNewMessage: () => void;
  /** Pin or unpin a channel in the caller's own sidebar. */
  onToggleFavorite: (id: string) => void;
  onGlobalSearch: () => void;
  onLeaveChannel: (id: string) => void;
  /** Rejoin a public channel the user had left (the menu offers one or the other, never both). */
  onJoinChannel: (id: string) => void;
  onChannelSettings: (id: string) => void;
  onChannelNotifications: (id: string) => void;
  onMarkRead: (id: string) => void;
  onOpenNotification: (channelId: string, messageId: string, id: string) => void;
  onToggleNotifRead: (id: string, read: boolean) => void;
  onMarkAllNotifsRead: () => void;
  onOpenNotifPrefs: () => void;
  /**
   * Leave the space on screen. This menu sits under the space's name, so its last entry acts on the
   * space: it used to be "sign out", which ended the whole session from a menu about one space.
   */
  onLeaveSpace: () => void;
  /** Compact (mobile) mode: full width, no wordmark/header/search (the mobile top bar owns those). */
  compact?: boolean;
  /** Render only one section, for the compact bottom-tab panels. Omit for the full desktop column. */
  only?: "channels" | "messages" | "activity";
  /** Dev/audit only: open the notification center on mount so the popover can be probed under zoom. */
  openNotifications?: boolean;
};

/** Channel/DM navigation column for the active workspace. */
export function Sidebar({
  workspace,
  channels,
  directMessages,
  onHideDm,
  view,
  channel,
  mentionCount,
  channelPrefs,
  notifications,
  notifUnread,
  onView,
  onChannel,
  onNotify,
  onInvite,
  onNewChannel,
  canBrowseSpace,
  onNewMessage,
  onToggleFavorite,
  onGlobalSearch,
  onLeaveChannel,
  onJoinChannel,
  onChannelSettings,
  onChannelNotifications,
  onMarkRead,
  onOpenNotification,
  onToggleNotifRead,
  onMarkAllNotifsRead,
  onOpenNotifPrefs,
  onLeaveSpace,
  compact = false,
  only,
  openNotifications = false,
}: SidebarProps) {
  const { t } = useTranslation();
  const showActivity = !only || only === "activity";
  const showChannels = !only || only === "channels";
  const showMessages = !only || only === "messages";
  const showFooter = !only || only === "channels";
  const channelMenu = (channel: Channel): SideMenuItem[] => [
    {
      icon: channel.fav ? "star-off" : "star",
      label: channel.fav ? t("sidebar.unfavourite") : t("sidebar.favourite"),
      onClick: () => onToggleFavorite(channel.id),
    },
    { icon: "check-check", label: t("sidebar.markRead"), onClick: () => onMarkRead(channel.id) },
    { icon: "bell", label: t("notif.title"), onClick: () => onChannelNotifications(channel.id) },
    { icon: "settings", label: t("sidebar.channelSettings"), onClick: () => onChannelSettings(channel.id) },
    // A public channel stays readable after leaving it, so the entry flips to rejoining rather than
    // disappearing: leaving is not a one-way door.
    channel.member === false
      ? { icon: "user-plus", label: t("sidebar.joinChannel"), onClick: () => onJoinChannel(channel.id) }
      : { icon: "log-out", label: t("sidebar.leaveChannel"), danger: true, onClick: () => onLeaveChannel(channel.id) },
  ];
  const dmMenu = (id: string, name: string): SideMenuItem[] => [
    { icon: "check-check", label: t("sidebar.markRead"), onClick: () => onMarkRead(id) },
    { icon: "bell", label: t("notif.title"), onClick: () => onChannelNotifications(id) },
    // Hiding used to be a toast and nothing else. It now takes the conversation out of the list
    // until it has something to say again; the history is untouched and a new message brings it
    // back, which is what keeps this from being a way to miss one.
    {
      icon: "x",
      label: t("sidebar.hideConversation"),
      onClick: () => {
        onHideDm(id);
        onNotify({
          tone: "info",
          title: t("sidebar.hidden"),
          description: t("sidebar.hiddenHint", { name }),
        });
      },
    },
  ];
  const notifMutedFor = (id: string): boolean => {
    const p = channelPrefs[id];
    return !!p && (p.muted || p.level === "none");
  };
  const [wsMenu, setWsMenu] = useState(false);
  const wsRef = useRef<HTMLButtonElement>(null);
  const [notifClicked, setNotifClicked] = useState(false);
  // Derive the open state from the user toggle OR the dev/audit deep-link flag (which arrives post-mount
  // as a prop). Deriving avoids a set-state-in-effect and any server/first-client render divergence.
  const notifOpen = notifClicked || openNotifications;
  const setNotifOpen = setNotifClicked;
  const bellRef = useRef<HTMLButtonElement>(null);

  return (
    <nav
      aria-label={t("sidebar.channelsAndMessages")}
      style={{ ...styles.side, width: compact ? "100%" : styles.side.width, flex: compact ? 1 : styles.side.flex }}
    >
      {!compact ? (
        <>
          <Wordmark />
          <div style={styles.head}>
            <button
              ref={wsRef}
              style={styles.wsName}
              onClick={() => setWsMenu((o) => !o)}
              aria-expanded={wsMenu}
              // The visible label is the workspace name; give the control a stable accessible name so
              // it is announced even before a workspace has loaded (empty name).
              aria-label={workspace?.name ? t("sidebar.spaceSwitchNamed", { name: workspace.name }) : t("sidebar.spaceSwitch")}
            >
              {workspace?.name}
              <Icon name="chevron-down" size={14} />
            </button>
            <MenuPopover
              anchorRef={wsRef}
              open={wsMenu}
              onClose={() => setWsMenu(false)}
              items={[
                { type: "label", label: workspace?.name ?? t("sidebar.space") },
                ...(canBrowseSpace
                  ? [{ icon: "user-plus", label: t("sidebar.invitePeople"), onClick: onInvite }]
                  : []),
                { icon: "settings", label: t("sidebar.spaceSettings"), onClick: () => onView("settings") },
                ...(canBrowseSpace
                  ? [{ icon: "hard-drive", label: t("sidebar.spaceFiles"), onClick: () => onView("files") }]
                  : []),
                { type: "separator" },
                { icon: "log-out", label: t("space.leave"), danger: true, onClick: onLeaveSpace },
              ]}
            />
            <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <span style={{ position: "relative", display: "flex" }}>
                <IconButton
                  ref={bellRef}
                  icon="bell"
                  label={t("notif.title")}
                  size="sm"
                  aria-expanded={notifOpen}
                  onClick={() => setNotifOpen((o) => !o)}
                />
                {notifUnread > 0 ? (
                  <span style={{ position: "absolute", top: -3, right: -3, pointerEvents: "none" }}>
                    <Badge count={notifUnread} />
                  </span>
                ) : null}
              </span>
              <IconButton icon="square-pen" label={t("shell.newMessage")} size="sm" onClick={onNewMessage} />
            </span>
            <NotificationCenter
              anchorRef={bellRef}
              open={notifOpen}
              onClose={() => setNotifOpen(false)}
              notifications={notifications}
              onOpen={(channelId, messageId, id) => {
                setNotifOpen(false);
                onOpenNotification(channelId, messageId, id);
              }}
              onToggleRead={onToggleNotifRead}
              onMarkAllRead={onMarkAllNotifsRead}
              onOpenPrefs={() => {
                setNotifOpen(false);
                onOpenNotifPrefs();
              }}
            />
          </div>
          <div style={{ padding: "8px 8px 0" }}>
            <Input
              size="sm"
              icon="search"
              placeholder={t("sidebar.searchPlaceholder")}
              readOnly
              onClick={onGlobalSearch}
            />
          </div>
        </>
      ) : null}
      <div style={styles.scroll}>
        {showActivity ? (
          <>
            <SideItem icon="inbox" label={t("sidebar.threads")} active={view === "threads"} onClick={() => onView("threads")} />
            <SideItem icon="at-sign" label={t("activity.mentions")} active={view === "mentions"} unread={mentionCount} onClick={() => onView("mentions")} />
            {canBrowseSpace ? (
              <SideItem icon="hard-drive" label={t("sidebar.spaceFiles")} active={view === "files"} onClick={() => onView("files")} />
            ) : null}
            <SideItem icon="bookmark" label={t("activity.saved")} active={view === "saved"} onClick={() => onView("saved")} />
          </>
        ) : null}

        {showChannels ? (
          <>
            <div style={styles.sect}>{t("sidebar.favourites")}</div>
            {channels.every((c) => !c.fav) ? (
              // Says how to fill it, since there is no button that could: a favourite is set on the
              // channel itself, from its own menu.
              <p style={styles.empty}>
                {t("sidebar.favouriteHint")}
              </p>
            ) : null}
            {channels
              .filter((c) => c.fav)
              .map((c) => (
                <SideItem
                  key={c.id}
                  label={c.name}
                  unread={c.unread}
                  notifMuted={notifMutedFor(c.id)}
                  active={view === "channel" && channel === c.id}
                  onClick={() => onChannel(c.id)}
                  menuItems={channelMenu(c)}
                >
                  <Icon
                    name={c.type === "private" ? "lock" : "hash"}
                    size={13}
                    title={c.type === "private" ? t("sidebar.privateChannel") : undefined}
                    style={{ color: "var(--text-muted)" }}
                  />
                </SideItem>
              ))}

            <div style={styles.sect}>
              {t("tabs.channels")}
              {canBrowseSpace ? (
                <button
                  onClick={onNewChannel}
                  aria-label={t("sidebar.newChannel")}
                  style={{ border: 0, background: "none", padding: 0, cursor: "pointer", color: "var(--text-subtle)", display: "flex" }}
                >
                  <Icon name="plus" size={13} />
                </button>
              ) : null}
            </div>
            {channels.every((c) => c.fav) ? (
              // Favouriting the only channel of a space emptied this section, which then read as a
              // space with no channels at all. What is true is said instead, and the two cases are
              // not the same sentence.
              <p style={styles.empty}>
                {channels.length === 0
                  ? t("sidebar.noChannel")
                  : t("sidebar.allFavourites")}
              </p>
            ) : null}
            {channels
              .filter((c) => !c.fav)
              .map((c) => (
                <SideItem
                  key={c.id}
                  label={c.name}
                  unread={c.unread}
                  muted={c.type === "archived"}
                  notifMuted={notifMutedFor(c.id)}
                  active={view === "channel" && channel === c.id}
                  onClick={() => onChannel(c.id)}
                  menuItems={channelMenu(c)}
                >
                  <Icon
                    name={c.type === "archived" ? "archive" : c.type === "private" ? "lock" : "hash"}
                    size={13}
                    title={c.type === "archived" ? t("sidebar.archivedChannel") : c.type === "private" ? t("sidebar.privateChannel") : undefined}
                    style={{ color: "var(--text-muted)" }}
                  />
                </SideItem>
              ))}
          </>
        ) : null}

        {showMessages ? (
          <>
            <div style={styles.sect}>{t("sidebar.directMessages")}</div>
            {directMessages.length === 0 ? (
              <SideItem icon="square-pen" label={t("sidebar.startConversation")} onClick={onNewMessage} />
            ) : null}
            {directMessages.map((d) => (
              <SideItem
                key={d.id}
                label={d.name}
                unread={d.unread}
                notifMuted={notifMutedFor(d.id)}
                active={view === "channel" && channel === d.id}
                tag={d.bot ? <Tag>{t("sidebar.bot")}</Tag> : undefined}
                onClick={() => onChannel(d.id)}
                menuItems={dmMenu(d.id, d.name)}
              >
                <Avatar name={d.name} src={getAvatar(d.name)} size={20} presence={d.presence} kind={d.bot ? "bot" : "person"} shape={d.bot ? "round" : "square"} />
              </SideItem>
            ))}
          </>
        ) : null}

        {showFooter ? (
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border-subtle)" }}>
            {/*
              The import entry is deliberately absent: no importer exists yet, so offering it
              promises a migration the product cannot perform. The dialog behind it is kept intact
              and this line comes back with the first real importer, listing only the sources that
              are actually supported by then.
            */}
            <SideItem icon="settings" label={t("sidebar.spaceSettings")} active={view === "settings"} onClick={() => onView("settings")} />
          </div>
        ) : null}
      </div>
    </nav>
  );
}
