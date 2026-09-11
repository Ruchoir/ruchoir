"use client";

import { type CSSProperties, Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { Avatar, Icon, IconButton, Tooltip } from "@/components/ds";
import { getAvatar, getChannelMembers } from "@/lib/data";
import type { Channel, DirectMessage, Message, MessageAttachment, SpaceFile } from "@/lib/data";
import type { Presence } from "@/components/ds";
import { useProfile } from "../app/useProfile";
import { useMountAnimation } from "../app/useMountAnimation";
import type { ChannelNotifPref } from "../app/notifications";
import { ProfilePanel } from "./ProfilePanel";
import type { ChannelPanel, Toast } from "../app/types";
import { ChannelMenu } from "./ChannelMenu";
import {
  AddPeopleDialog,
  ChannelNotificationsDialog,
  ChannelSettingsDialog,
  LeaveChannelDialog,
} from "./ChannelDialogs";
import { SearchPanel } from "./SearchPanel";
import { type ChannelMember, SidePanel } from "./SidePanel";
import { Composer } from "./Composer";
import { MessageRow } from "./MessageRow";
import { SystemMessage } from "./SystemMessage";
import { ThreadPanel } from "./ThreadPanel";
import { TypingIndicator } from "./TypingIndicator";
import { useStickToBottom } from "./useStickToBottom";

/** Right-hand dock: animates in/out, stays mounted during exit, and cross-fades on content switch. */
function RightDock({
  open,
  contentKey,
  compact = false,
  children,
}: {
  open: boolean;
  contentKey: string;
  compact?: boolean;
  children: ReactNode;
}) {
  const { mounted, closing } = useMountAnimation(open, 200);
  // Remember the last open content so it stays visible through the exit animation. Written in an effect
  // (not during render); the exit-time reads below are the one place the ref must be read during render.
  const last = useRef<ReactNode>(null);
  const lastKey = useRef("");
  useEffect(() => {
    if (open) {
      last.current = children;
      lastKey.current = contentKey;
    }
  });
  if (!mounted) return null;
  // Compact: the panel (members, files, thread, profile) can no longer be a fixed column beside the
  // feed, so it covers the whole view as a full-screen sheet. Setting `--panel-width: 100%` makes the
  // panels (which size themselves from that variable) fill the width instead of staying at 340px.
  // Its own header close button dismisses it.
  const container: CSSProperties = compact
    ? {
        position: "absolute",
        inset: 0,
        zIndex: 40,
        width: "100%",
        display: "flex",
        background: "var(--surface-canvas)",
        ["--panel-width" as string]: "100%",
      }
    : { display: "flex", flex: "none" };
  // The exit animation renders the cached last-open content, which requires reading these refs during
  // render; scope the ref-access rule here since the values are written from the effect above.
  /* eslint-disable react-hooks/refs */
  const dockKey = open ? contentKey : lastKey.current;
  const dockNode = open ? children : last.current;
  /* eslint-enable react-hooks/refs */
  return (
    <div style={container} className={closing ? "wc-dock--out" : "wc-dock--in"}>
      <div
        key={dockKey}
        className="wc-dock-content"
        style={{ display: "flex", flex: compact ? 1 : undefined, minWidth: 0, background: compact ? "var(--surface-canvas)" : undefined }}
      >
        {dockNode}
      </div>
    </div>
  );
}

const PRESENCE_LABEL: Record<string, string> = {
  online: "En ligne",
  away: "Absent",
  busy: "Occupé",
  offline: "Hors ligne",
};

const styles: Record<string, CSSProperties> = {
  archivedNotice: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    margin: "0 16px 16px",
    padding: "12px 16px",
    fontSize: 13,
    color: "var(--text-muted)",
    background: "var(--surface-sunken)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
  },
  top: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 12px 0 16px",
    borderBottom: "1px solid var(--border-subtle)",
    background: "var(--alpha-paper-90)",
    backdropFilter: "blur(6px)",
  },
  title: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    flexShrink: 0,
    margin: 0, // rendered as an <h1>: drop the UA heading margin
    fontSize: 17,
    fontWeight: 600,
    letterSpacing: "var(--tracking-tight)",
    color: "var(--text-strong)",
    whiteSpace: "nowrap",
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    fontSize: 13,
    color: "var(--text-muted)",
  },
  feed: { flex: 1, overflow: "auto", padding: "20px 0 8px" },
  toBottom: {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    bottom: 12,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 14px",
    borderRadius: 999,
    border: "1px solid var(--border-subtle)",
    background: "var(--surface-raised)",
    boxShadow: "var(--shadow-popover)",
    color: "var(--text-strong)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  inner: { maxWidth: "var(--channel-measure)", margin: "0 auto", padding: "0 24px" },
  day: { display: "flex", alignItems: "center", gap: 12, margin: "18px 0" },
  dayLine: { flex: 1, height: 1, background: "var(--border-subtle)" },
  dayLbl: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
  },
  unread: { display: "flex", alignItems: "center", gap: 10, margin: "10px 0" },
  unreadLine: { flex: 1, height: 1, background: "var(--terracotta-400)" },
  unreadLabel: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-accent)",
  },
};

/** Message-action handlers, each taking the target message id. Built in AppRoot. */
export type MessageActionHandlers = {
  react: (messageId: string, emoji: string) => void;
  openThread: (messageId: string) => void;
  toggleSave: (messageId: string) => void;
  edit: (messageId: string) => void;
  togglePin: (messageId: string) => void;
  copyLink: (messageId: string) => void;
  copyMessage: (messageId: string) => void;
  markUnread: (messageId: string) => void;
  remove: (messageId: string) => void;
  openProfile: (name: string) => void;
  editProfile: (name: string) => void;
  message: (name: string) => void;
};

type MenuDialog = "settings" | "notifications" | "addpeople" | "leave" | null;

export type ChannelScreenProps = {
  channel: Channel;
  /** Set when the open conversation is a direct message rather than a channel. */
  dm?: DirectMessage | null;
  messages: Message[];
  panel: ChannelPanel;
  threadId: string | null;
  profileName: string | null;
  profileEditing: boolean;
  unreadMarker: string | null;
  onSend: (text: string, attachment?: MessageAttachment) => void;
  /** Store a picked file for the open conversation and resolve to the attachment to carry. */
  onUploadAttachment: (file: File) => Promise<MessageAttachment>;
  /** The signed-in user changed their own avatar, so the roster the rows read has to follow. */
  onAvatarChanged: (url?: string) => void;
  onPanel: (panel: ChannelPanel) => void;
  onCloseThread: () => void;
  onCloseProfile: () => void;
  onNotify: (toast: Toast) => void;
  onUpdateChannel: (patch: Partial<Channel>) => void;
  onLeaveChannel: () => void;
  /** Rejoin this channel after leaving it (public channels only). */
  onJoinChannel: () => void;
  /** Current notification preference for this conversation, and a persist callback. */
  notifPref: ChannelNotifPref;
  onSaveNotifPref: (pref: ChannelNotifPref) => void;
  /** When set, the feed scrolls to and flashes this message after it renders. */
  focusMessageId?: string | null;
  /** Presence of the DM counterpart (from the live presence map); ignored for channels. */
  dmPresence?: Presence;
  /** Display names currently typing in this conversation. */
  typingNames?: string[];
  /** The space's members with live presence and uploaded avatar (member list + message rows). */
  members: { name: string; presence: Presence; bot?: boolean; avatar?: string }[];
  /** Who has read each message, by display name, keyed by message id. */
  readBy: Record<string, string[]>;
  /** How many people other than the reader are in this conversation, for "everyone". */
  readAudience: number;
  /** The space's files, for the in-channel file panel and search. */
  files: SpaceFile[];
  /** User id of the profile shown in the right panel, when known (enables the real profile fetch). */
  profileUserId?: string;
  /** Live presence of the profile shown in the right panel. */
  profilePresence?: Presence;
  /** Called as the user composes, to emit a typing signal over the realtime channel. */
  onTyping?: () => void;
  /** Compact (mobile) mode: the right panel becomes a full-width overlay instead of a column. */
  compact?: boolean;
  actions: MessageActionHandlers;
};

/** The channel (or direct message) view: header, message feed, composer, and optional right panel. */
/** How long a silence has to be before the same person starts a new block. */
const GROUPING_WINDOW_MS = 5 * 60 * 1000;

/**
 * Whether a message continues the one before it, and should be drawn without repeating its header.
 *
 * Someone writing three sentences in a row wrote one thing; stamping their name and face on each
 * line turns a conversation into a list of records and pushes the actual words down the page. Five
 * minutes is the pause after which they are saying something new, and the block starts again.
 *
 * A system notice never continues anything, and never lets anything continue across it: whatever
 * came before it is over.
 */
function followsSameAuthor(previous: Message | undefined, current: Message): boolean {
  if (!previous || previous.kind === "system" || current.kind === "system") return false;
  if (previous.author !== current.author) return false;
  // Ids are compared when both are known, so two people sharing a display name are still two people.
  if (previous.authorId && current.authorId && previous.authorId !== current.authorId) return false;
  if (!previous.createdAt || !current.createdAt) return false;
  const gap = Date.parse(current.createdAt) - Date.parse(previous.createdAt);
  return Number.isFinite(gap) && gap >= 0 && gap < GROUPING_WINDOW_MS;
}

export function ChannelScreen({
  channel,
  dm,
  messages,
  panel,
  threadId,
  profileName,
  profileEditing,
  unreadMarker,
  onSend,
  onUploadAttachment,
  onAvatarChanged,
  onPanel,
  onCloseThread,
  onCloseProfile,
  onNotify,
  onUpdateChannel,
  onLeaveChannel,
  onJoinChannel,
  notifPref,
  onSaveNotifPref,
  focusMessageId,
  members,
  readBy,
  readAudience,
  files,
  dmPresence,
  typingNames,
  profileUserId,
  profilePresence,
  onTyping,
  compact = false,
  actions,
}: ChannelScreenProps) {
  const isDm = !!dm;
  // An archived channel is read-only: the API refuses new messages, so the composer gives way to a note.
  const isArchived = !isDm && channel.type === "archived";
  const memberList: ChannelMember[] = members.map((m) => ({ id: m.name, name: m.name, presence: m.presence, bot: m.bot, avatar: m.avatar }));
  const presenceByName = new Map(members.map((m) => [m.name, m.presence] as const));
  // Uploaded avatars, by display name: a row only knows its author's name, and the roster is the one
  // place that holds the picture. Absent means the locally generated avatar, which is the default.
  const avatarByName = new Map(members.map((m) => [m.name, m.avatar] as const));
  const threadParent = threadId != null ? messages.find((m) => m.id === threadId) : undefined;
  const pinned = messages.filter((m) => m.pinned && !m.deleted);
  const togglePanel = (p: Exclude<ChannelPanel, null>) => onPanel(panel === p ? null : p);
  const [menuDialog, setMenuDialog] = useState<MenuDialog>(null);

  // Follows the conversation while the reader is at the end of it, and leaves them alone when
  // they are not. Height changes count as much as new messages: an attachment that finishes
  // loading, an edit, a reaction wrapping onto a new line, or the feed's own padding growing for
  // the typing indicator all used to leave the last message half off screen.
  const { ref: feedRef, following, scrollToBottom } = useStickToBottom<HTMLDivElement>(channel.id);
  const msgCount = messages.length;

  const [highlightFile, setHighlightFile] = useState<string | null>(null);
  const jumpToFile = (fileName: string) => {
    onPanel("files");
    setHighlightFile(fileName);
  };

  const jumpToMessage = (id: string) => {
    const el = feedRef.current?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("wc-flash");
    // Re-trigger the flash animation.
    void el.offsetWidth;
    el.classList.add("wc-flash");
  };

  // Jump to a message requested from global search or an activity view, once it has rendered.
  useEffect(() => {
    if (!focusMessageId) return;
    const raf = requestAnimationFrame(() => jumpToMessage(focusMessageId));
    return () => cancelAnimationFrame(raf);
  }, [focusMessageId, channel.id]);

  const contentKey = profileName
    ? `profile:${profileName}`
    : threadParent
      ? `thread:${threadParent.id}`
      : panel
        ? `panel:${panel}`
        : "";
  const rightNode: ReactNode = profileName ? (
    <ProfilePanel
      name={profileName}
      userId={profileUserId}
      presence={profilePresence}
      startEditing={profileEditing}
      onClose={onCloseProfile}
      onMessage={() => actions.message(profileName)}
      onAvatarChanged={onAvatarChanged}
      onNotify={onNotify}
    />
  ) : threadParent ? (
    <ThreadPanel parent={threadParent} conversationId={channel.id} onClose={onCloseThread} />
  ) : panel === "search" ? (
    <SearchPanel
      messages={messages}
      files={files}
      onClose={() => onPanel(null)}
      onJump={jumpToMessage}
      onJumpFile={jumpToFile}
    />
  ) : panel ? (
    <SidePanel
      kind={panel}
      files={files}
      members={memberList}
      pinned={pinned}
      highlightFile={highlightFile}
      onClose={() => onPanel(null)}
      onSelectMember={actions.openProfile}
      onJump={jumpToMessage}
      onNotify={onNotify}
    />
  ) : null;

  const dmProfile = useProfile(dm?.userId, dm?.name ?? "");
  const typing = typingNames ?? [];

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0, minHeight: 0, position: "relative" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        <div style={styles.top}>
          {isDm ? (
            <>
              <h1 style={styles.title}>
                <Avatar name={dm.name} src={getAvatar(dm.name)} size={22} presence={(dmPresence ?? "offline")} kind={dm.bot ? "bot" : "person"} />
                {dm.name}
              </h1>
              <div style={styles.meta}>{dmProfile?.role ?? PRESENCE_LABEL[(dmPresence ?? "offline")]}</div>
            </>
          ) : (
            <>
              <h1 style={styles.title}>
                <Icon
                  name={channel.type === "private" ? "lock" : "hash"}
                  size={15}
                  title={channel.type === "private" ? "Canal privé" : undefined}
                  style={{ color: "var(--text-muted)" }}
                />
                {channel.name}
              </h1>
              <div style={styles.meta}>
                <Icon name="users" size={13} />
                {memberList.length}
                {channel.topic ? (
                  <>
                    <span aria-hidden style={{ color: "var(--border-strong)" }}>·</span>
                    {channel.topic}
                  </>
                ) : null}
              </div>
            </>
          )}
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", minWidth: 0, overflowX: "auto", flexShrink: 1, scrollbarWidth: "none" }}>
          <Tooltip label="Rechercher dans la conversation" side="bottom">
            <IconButton
              className="wc-ibtn--bare"
              icon="search"
              label="Rechercher dans la conversation"
              aria-pressed={panel === "search"}
              onClick={() => togglePanel("search")}
            />
          </Tooltip>
          <Tooltip label="Messages épinglés" side="bottom">
            <IconButton
              className="wc-ibtn--bare"
              icon="pin"
              label="Messages épinglés"
              aria-pressed={panel === "pinned"}
              onClick={() => togglePanel("pinned")}
            />
          </Tooltip>
          <Tooltip label="Fichiers" side="bottom">
            <IconButton
              className="wc-ibtn--bare"
              icon="folder"
              label="Fichiers"
              aria-pressed={panel === "files"}
              onClick={() => togglePanel("files")}
            />
          </Tooltip>
          {!isDm ? (
            <Tooltip label="Membres" side="bottom">
              <IconButton
                className="wc-ibtn--bare"
                icon="users"
                label="Membres"
                aria-pressed={panel === "members"}
                onClick={() => togglePanel("members")}
              />
            </Tooltip>
          ) : null}
          {!isDm ? (
            <ChannelMenu
              onSettings={() => setMenuDialog("settings")}
              onNotifications={() => setMenuDialog("notifications")}
              onAddPeople={() => setMenuDialog("addpeople")}
              onLeave={() => setMenuDialog("leave")}
              onJoin={onJoinChannel}
              member={channel.member !== false}
            />
          ) : null}
          </div>
        </div>
        <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ ...styles.feed, paddingBottom: typing.length > 0 ? 60 : 8 }} ref={feedRef}>
          <div style={styles.inner}>
            <div style={{ padding: "4px 0 14px" }}>
              {isDm ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Avatar name={dm.name} src={getAvatar(dm.name)} size={44} presence={(dmPresence ?? "offline")} kind={dm.bot ? "bot" : "person"} />
                    <div>
                      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "var(--tracking-tight)", color: "var(--text-strong)" }}>
                        {dm.name}
                      </div>
                      {dmProfile?.role ? <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{dmProfile.role}</div> : null}
                    </div>
                  </div>
                  <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 10, maxWidth: 560 }}>
                    Ceci est le début de votre conversation privée avec {dm.name.split(" ")[0]}. Les messages ne sont visibles que
                    par vous deux.
                  </p>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "var(--tracking-tight)", color: "var(--text-strong)" }}>
                    #{channel.name}
                  </div>
                  <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 6, maxWidth: 560 }}>
                    {isArchived ? "Canal archivé." : channel.type === "private" ? "Canal privé." : "Canal public."}{" "}
                    {channel.topic ? `${channel.topic}. ` : ""}
                    {channel.imported ? `L'historique a été repris depuis ${channel.imported}.` : "Début du canal."}
                  </p>
                </>
              )}
            </div>
            {msgCount > 0 ? (
              <div style={styles.day}>
                <span style={styles.dayLine} />
                <span style={styles.dayLbl}>Aujourd&apos;hui</span>
                <span style={styles.dayLine} />
              </div>
            ) : null}
            {messages.map((m, index) => (
              <Fragment key={m.id}>
                {m.id === unreadMarker ? (
                  <div style={styles.unread}>
                    <span style={styles.unreadLine} />
                    <span style={styles.unreadLabel}>Non lus</span>
                  </div>
                ) : null}
                {m.kind === "system" ? (
                  <SystemMessage m={m} />
                ) : (
                  <MessageRow
                    m={m}
                    readBy={readBy[m.id]}
                    readAudience={readAudience}
                    grouped={followsSameAuthor(messages[index - 1], m) && m.id !== unreadMarker}
                    endsRun={
                      !messages[index + 1] ||
                      messages[index + 1].id === unreadMarker ||
                      !followsSameAuthor(m, messages[index + 1])
                    }
                    authorPresence={presenceByName.get(m.author)}
                    authorAvatar={avatarByName.get(m.author)}
                    actions={{
                      onReact: (emoji) => actions.react(m.id, emoji),
                      onOpenThread: () => actions.openThread(m.id),
                      onToggleSave: () => actions.toggleSave(m.id),
                      onEdit: () => actions.edit(m.id),
                      onTogglePin: () => actions.togglePin(m.id),
                      onCopyLink: () => actions.copyLink(m.id),
                      onCopyMessage: () => actions.copyMessage(m.id),
                      onMarkUnread: () => actions.markUnread(m.id),
                      onDelete: () => actions.remove(m.id),
                      onOpenProfile: () => actions.openProfile(m.author),
                      onEditProfile: () => actions.editProfile(m.author),
                      onMessage: () => actions.message(m.author),
                      onOpenMention: (name) => actions.openProfile(name),
                    }}
                  />
                )}
              </Fragment>
            ))}
          </div>
        </div>
          {!following && msgCount > 0 ? (
            // Offered rather than forced: the reader scrolled up on purpose, and this is how they
            // say they are done. It sits above the typing indicator, which occupies the same
            // corner when someone is writing.
            <button
              type="button"
              onClick={() => scrollToBottom("smooth")}
              style={styles.toBottom}
            >
              <Icon name="chevron-down" size={14} />
              Derniers messages
            </button>
          ) : null}
          {typing.length > 0 ? (
            <>
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 56,
                  background: "linear-gradient(0deg, var(--surface-canvas) 55%, transparent 100%)",
                  pointerEvents: "none",
                }}
              />
              <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, pointerEvents: "none" }}>
                <TypingIndicator names={typing} />
              </div>
            </>
          ) : null}
        </div>
        {isArchived ? (
          // An archived channel is read-only server-side: showing a composer would offer an action
          // the API refuses. The history stays open.
          <p style={styles.archivedNotice}>
            <Icon name="archive" size={14} />
            Ce canal est archivé : il reste consultable, mais on n&apos;y écrit plus.
          </p>
        ) : (
          <Composer
            channelName={isDm ? dm.name : channel.name}
            onSend={onSend}
            onUpload={onUploadAttachment}
            onNotify={onNotify}
            onTyping={onTyping}
          />
        )}
      </div>
      <RightDock open={rightNode != null} contentKey={contentKey} compact={compact}>
        {rightNode}
      </RightDock>

      {menuDialog === "settings" ? (
        <ChannelSettingsDialog channel={channel} onClose={() => setMenuDialog(null)} onUpdate={onUpdateChannel} onNotify={onNotify} />
      ) : null}
      {menuDialog === "notifications" ? (
        <ChannelNotificationsDialog
          channelName={isDm ? dm!.name : channel.name}
          isDm={isDm}
          value={notifPref}
          onClose={() => setMenuDialog(null)}
          onSave={onSaveNotifPref}
          onNotify={onNotify}
        />
      ) : null}
      {menuDialog === "addpeople" ? (
        <AddPeopleDialog channelName={channel.name} people={getChannelMembers()} onClose={() => setMenuDialog(null)} onNotify={onNotify} />
      ) : null}
      {menuDialog === "leave" ? (
        <LeaveChannelDialog
          channelName={channel.name}
          onClose={() => setMenuDialog(null)}
          onConfirm={() => {
            setMenuDialog(null);
            onLeaveChannel();
          }}
        />
      ) : null}
    </div>
  );
}
