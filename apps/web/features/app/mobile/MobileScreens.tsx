"use client";

/**
 * The phone shell's root screens: the three tabs (home, messages, activity), their shared header,
 * and the button that starts a conversation. What these open (a conversation, a thread, a view) is
 * pushed over them by AppRoot, full screen, with its own way back.
 *
 * Modelled on how team chat reads on a phone: one column, big targets, the search always one tap
 * away at the top, and the list of what is new before the list of everything.
 */

import type { CSSProperties, ReactNode } from "react";
import { Avatar, Badge, EmptyState, Icon, type IconName, type Presence } from "@/components/ds";
import type { DirectMessage, Workspace } from "@/lib/data";
import { getAvatar } from "@/lib/data";
import { useTranslation } from "@/lib/i18n";
import { formatStamp } from "@/lib/i18n/format";
import type { AppNotification } from "../notifications";
import { NotificationFeed } from "../NotificationCenter";
import { oneLine } from "../preview";

const headerTitle: CSSProperties = {
  margin: 0,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 24,
  fontWeight: 700,
  letterSpacing: "var(--tracking-display)",
  color: "var(--text-strong)",
};

/** The signed-in person, at the end of every root header: their menu (status, profile, preferences). */
function YouButton({ name, presence, onClick }: { name: string; presence: Presence; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="wc-mhead__you" aria-label={t("shell.myProfileAndStatus")} onClick={onClick}>
      <Avatar name={name} src={getAvatar(name)} size={34} presence={presence} />
    </button>
  );
}

export type MobileHeaderProps = {
  /** The screen's name, drawn large. */
  title: ReactNode;
  /** When given, the title is a button (the space's name opens the space switcher). */
  onTitle?: () => void;
  titleLabel?: string;
  /** Drawn before the title: the space's icon on the home tab. */
  leading?: ReactNode;
  currentUser: string;
  presence: Presence;
  onYou: () => void;
  onSearch?: () => void;
};

/** A root screen's header: its name, large, and the signed-in person's avatar. */
export function MobileHeader({ title, onTitle, titleLabel, leading, currentUser, presence, onYou, onSearch }: MobileHeaderProps) {
  const { t } = useTranslation();
  const heading = <h1 style={headerTitle}>{title}</h1>;
  return (
    <header className="wc-mhead">
      {onTitle ? (
        <button type="button" className="wc-mhead__title" onClick={onTitle} aria-label={titleLabel}>
          {leading}
          {heading}
          <Icon name="chevron-down" size={18} style={{ flex: "none", color: "var(--text-muted)" }} />
        </button>
      ) : (
        <span className="wc-mhead__title">
          {leading}
          {heading}
        </span>
      )}
      {onSearch ? (
        <button type="button" className="wc-mhead__icon" aria-label={t("common.search")} onClick={onSearch}>
          <Icon name="search" size={20} />
        </button>
      ) : null}
      <YouButton name={currentUser} presence={presence} onClick={onYou} />
    </header>
  );
}

/** The search field at the top of the home tab: a door to the search screen, not a field itself. */
export function MobileSearchField({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div style={{ padding: "0 16px 12px" }}>
      <button type="button" className="wc-msearch" onClick={onOpen}>
        <Icon name="search" size={18} />
        <span>{t("sidebar.searchPlaceholder")}</span>
      </button>
    </div>
  );
}

export type QuickLink = { id: string; icon: IconName; label: string; count?: number; mention?: boolean; onOpen: () => void };

/**
 * The shortcuts under the search: threads, mentions, saved, files. A row of cards that scrolls
 * sideways, each with its count, so what is waiting is seen before the channel list.
 */
export function QuickLinks({ links }: { links: QuickLink[] }) {
  return (
    <div className="wc-mchips" role="list">
      {links.map((l) => (
        <button key={l.id} type="button" role="listitem" className="wc-mchip" onClick={l.onOpen}>
          <span className="wc-mchip__top">
            <Icon name={l.icon} size={18} />
            {l.count ? <Badge count={l.count} tone={l.mention ? "mention" : "accent"} /> : null}
          </span>
          <span className="wc-mchip__label">{l.label}</span>
        </button>
      ))}
    </div>
  );
}

/** The floating button that starts a conversation, above the tabs at the thumb's corner. */
export function ComposeFab({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="wc-fab" aria-label={t("shell.newMessage")} onClick={onClick}>
      <Icon name="square-pen" size={22} />
    </button>
  );
}

export type MobileMessagesProps = {
  dms: DirectMessage[];
  onOpen: (id: string) => void;
  onNew: () => void;
};

/**
 * The messages tab: every direct conversation with what was last said and when, the most recent
 * first. What the sidebar lists by name, this lists by activity, because on a phone the question is
 * "who wrote to me", not "where is Léa".
 */
export function MobileMessages({ dms, onOpen, onNew }: MobileMessagesProps) {
  const { t } = useTranslation();
  const sorted = [...dms].sort((a, b) => (b.lastMessage?.at ?? "").localeCompare(a.lastMessage?.at ?? ""));
  if (sorted.length === 0) {
    return (
      <EmptyState
        icon="message-square"
        title={t("switcher.empty")}
        description={t("mobile.noDmText")}
        action={
          <button type="button" className="wc-btn wc-btn--md wc-btn--primary" onClick={onNew}>
            <Icon name="square-pen" size={16} />
            {t("sidebar.startConversation")}
          </button>
        }
        style={{ flex: 1 }}
      />
    );
  }
  return (
    <ul className="wc-mlist">
      {sorted.map((d) => {
        const unread = d.unread > 0;
        const text = d.lastMessage ? oneLine(d.lastMessage.excerpt) : "";
        return (
          <li key={d.id}>
            <button type="button" className={`wc-mrow${unread ? " wc-mrow--unread" : ""}`} onClick={() => onOpen(d.id)}>
              <Avatar name={d.name} src={getAvatar(d.name)} size={44} presence={d.presence} kind={d.bot ? "bot" : "person"} shape={d.bot ? "round" : "square"} />
              <span className="wc-mrow__body">
                <span className="wc-mrow__line">
                  <span className="wc-mrow__name">{d.name}</span>
                  {d.lastMessage ? <span className="wc-mrow__time">{formatStamp(d.lastMessage.at)}</span> : null}
                </span>
                <span className="wc-mrow__line">
                  <span className="wc-mrow__preview">
                    {d.lastMessage ? (d.lastMessage.mine ? t("mobile.youPrefix", { text }) : text) : t("sidebar.startConversation")}
                  </span>
                  {unread ? <Badge count={d.unread} tone={d.notify?.muted ? "neutral" : "mention"} /> : null}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export type MobileActivityProps = {
  notifications: AppNotification[];
  onOpen: (channelId: string, messageId: string, id: string) => void;
  onToggleRead: (id: string, read: boolean) => void;
};

/** The activity tab: the notification inbox, as a page. */
export function MobileActivity({ notifications, onOpen, onToggleRead }: MobileActivityProps) {
  return <NotificationFeed notifications={notifications} onOpen={onOpen} onToggleRead={onToggleRead} page />;
}

/** The space's own icon, for the home header. */
export function SpaceMark({ workspace }: { workspace?: Workspace }) {
  return <Avatar name={workspace?.name ?? ""} src={workspace?.iconUrl} kind="workspace" size={32} className="wc-mhead__space" />;
}
