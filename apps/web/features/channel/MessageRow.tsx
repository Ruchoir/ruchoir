"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Avatar, brandFor, Card, Dialog, FileIcon, Icon, IconButton, IconLink, Popover, Tag, Tooltip } from "@/components/ds";
import { getCurrentUser, getMentionNames, getPresence, getSpaceRooms } from "@/lib/data";
import type { ImportSource, Message, MessageAttachment } from "@/lib/data";
import type { Presence } from "@/components/ds";
import { ReactionPill } from "./ReactionPill";
import { MessageActionSheet } from "./MessageActionSheet";
import { useTouch } from "../app/useLayout";
import { UserProfileCard } from "../app/UserProfileCard";
import { prefetchProfile } from "../app/useProfile";
import { renderRichText } from "./richText";
import { InlineImage } from "./InlineImage";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { MessageMenu } from "./MessageMenu";
import { ReactionMenu } from "./ReactionMenu";
import { ReadReceipt } from "./ReadReceipt";
import { useTranslation } from "@/lib/i18n";
import { formatBytes, formatDateTime, formatRelativeStamp, formatStamp, formatTime, isSameDay } from "@/lib/i18n/format";
import { haptic } from "@/lib/haptics";

/** Everything a message row can do. Grouped to keep the prop surface readable. */
export type MessageActions = {
  onReact: (emoji: string) => void;
  onOpenThread: () => void;
  onToggleSave: () => void;
  onEdit: () => void;
  onTogglePin: () => void;
  onCopyLink: () => void;
  onCopyMessage: () => void;
  onMarkUnread: () => void;
  onDelete: () => void;
  onOpenProfile: () => void;
  onEditProfile: () => void;
  onMessage: () => void;
  /** Open the full profile of a user @-mentioned in the body, from the card a mention opens. */
  onOpenMention: (name: string) => void;
  /** Write to a user @-mentioned in the body, from the card a mention opens. */
  onMessageMention: (name: string) => void;
  /** Edit one's own profile, from the card opened on a mention of oneself. */
  onEditMentionProfile: (name: string) => void;
  /** The user id behind a mentioned name, so its card can load the real profile. */
  mentionUserId: (name: string) => string | undefined;
  /** Follow a `#room` written in a message, to the channel it names. */
  onOpenRoom?: (name: string) => void;
  /** Tick or untick the checklist item on this line of the body. Author-only, like any edit. */
  onToggleTask: (line: number, done: boolean) => void;
};

const styles: Record<string, CSSProperties> = {
  msg: {
    display: "flex",
    gap: 14,
    // Bottom padding reserves room for the hover read receipt so it never overlaps content.
    padding: "6px 8px 18px",
    margin: "0 -8px",
    borderRadius: "var(--radius-md)",
    position: "relative",
    transition: "background-color var(--duration-fast) var(--ease-out)",
  },
  author: { display: "flex", alignItems: "baseline", gap: 8 },
  gutterTime: {
    flex: "none",
    width: 34,
    paddingTop: 3,
    textAlign: "right",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    lineHeight: "var(--leading-normal)",
    color: "var(--text-subtle)",
    fontVariantNumeric: "tabular-nums",
    userSelect: "none",
    // One line, always. It wrapped, which made the row taller and pushed every message below it
    // down for as long as the cursor stayed there. Clipping it instead would have been worse: what
    // goes here is short by construction (see `gutterTime`), so it is allowed to spill into the
    // row's left padding on the rare wide glyph rather than be cut.
    whiteSpace: "nowrap",
  },
  name: { fontSize: 15, fontWeight: 700, color: "var(--text-strong)" },
  time: { fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" },
  body: {
    fontSize: 16,
    lineHeight: "var(--leading-normal)",
    color: "var(--text-body)",
    marginTop: 1,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  edited: { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-subtle)" },
  editedLine: { display: "block", marginTop: 2 },
  attachmentName: {
    display: "block",
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 14,
    fontWeight: 500,
    color: "var(--text-strong)",
  },
  actions: {
    position: "absolute",
    top: -18,
    right: 8,
    display: "flex",
    gap: 2,
    padding: 2,
    background: "var(--surface-raised)",
    border: "2px solid var(--ink)",
    borderRadius: "var(--radius-sm)",
    boxShadow: "var(--shadow-offset-sm)",
  },
  // Inside the reserve left under the last message of a run (18px, see the row's padding), and on
  // the hovered row's own colour with a fade on its left: at 6px from the bottom it sat on the last
  // line of text and read as glued to it, and wherever it still meets text (a message in the middle
  // of a run has no reserve) it now covers the line's end cleanly instead of touching it.
  receipt: {
    position: "absolute",
    right: 8,
    bottom: 1,
    padding: "1px 6px 1px 18px",
    borderRadius: "var(--radius-sm)",
    background: "linear-gradient(to right, transparent, var(--surface-hover) 14px)",
    pointerEvents: "none",
  },
};

/** One stored document in a message, kept to one line however long its original name is. */
function AttachmentCard({ attachment }: { attachment: MessageAttachment }) {
  const { t } = useTranslation();

  return (
    <div style={{ marginTop: 8, width: 360, maxWidth: "100%", minWidth: 0 }}>
      {attachment.deleted ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            padding: "8px 10px",
            borderRadius: "var(--radius-md)",
            border: "1.5px dashed var(--border-strong)",
            color: "var(--text-subtle)",
            fontSize: 13,
          }}
        >
          <Icon name="trash-2" size={14} style={{ flex: "none" }} />
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("message.fileDeleted", { name: attachment.name })}
          </span>
        </div>
      ) : (
        <Card
          variant="interactive"
          style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, overflow: "hidden", padding: "8px 10px" }}
        >
          <FileIcon name={attachment.name} size={32} />
          <span style={{ flex: "1 1 0", minWidth: 0, overflow: "hidden" }}>
            <span style={styles.attachmentName} title={attachment.name}>
              {attachment.name}
            </span>
            <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {formatBytes(attachment.sizeBytes)}
            </span>
          </span>
          {attachment.url ? (
            <span style={{ display: "inline-flex", flex: "none" }}>
              <IconLink
                icon="external-link"
                label={t("message.openInNewTab", { name: attachment.name })}
                size="sm"
                href={attachment.previewUrl ?? attachment.url}
                target="_blank"
                rel="noopener noreferrer"
              />
              <IconLink
                icon="download"
                label={t("message.downloadNamed", { name: attachment.name })}
                size="sm"
                href={attachment.url}
                download={attachment.name}
              />
            </span>
          ) : (
            <IconButton icon="download" label={t("message.download")} size="sm" disabled />
          )}
        </Card>
      )}
    </div>
  );
}

function reactionPill(mine?: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 28,
    padding: "0 9px",
    border: `1.5px solid ${mine ? "var(--ink)" : "var(--control-line)"}`,
    // One's own reaction is filled with the theme's pastel, which carries the dark ink.
    background: mine ? "var(--acc)" : "var(--surface-card)",
    borderRadius: "var(--radius-full)",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    fontWeight: 600,
    color: mine ? "var(--on-pastel)" : "var(--text-body)",
    cursor: "pointer",
    fontVariantNumeric: "tabular-nums",
    transition:
      "background-color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), transform var(--duration-instant) var(--ease-out)",
  };
}

export type MessageRowProps = {
  m: Message;
  authorPresence?: Presence;
  /** The author's uploaded avatar; absent falls back to the one generated from their name. */
  authorAvatar?: string;
  /**
   * This message continues the one above it: same person, minutes apart.
   *
   * The avatar and the name line are dropped, and the body keeps its place, so a run of messages
   * reads as one turn of speech rather than as a stack of identical cards. The time moves into the
   * gutter the avatar left, shown on hover, so it is still reachable without being repeated down
   * the page.
   */
  grouped?: boolean;
  /** Display names of the people who have read this message, from the conversation's read cursors. */
  readBy?: string[];
  /** How many people other than the reader are in the conversation, so "everyone" can be said. */
  readAudience?: number;
  /**
   * This message ends its run: nothing below continues it.
   *
   * The hover receipt needs room under the last line, and only there. Reserving it under every line
   * of a run would put the gap back that grouping exists to remove.
   */
  endsRun?: boolean;
  actions: MessageActions;
  /** Whether the pin entry belongs in this row's menu. See MessageMenu's own prop. */
  canPin?: boolean;
  /**
   * The product this conversation was imported from, for the provenance badge. A message carries
   * only that it was imported, not from where: the source belongs to the channel, and every
   * imported message in it came the same way.
   */
  importedFrom?: ImportSource;
  /**
   * This row is a reply, drawn inside a thread panel.
   *
   * A reply is a message like any other and keeps every action that acts on a message. What it
   * loses is what only means something in the feed: opening a thread of its own (threads are one
   * level deep, as everywhere), and marking the conversation unread from a line nobody reads there.
   */
  inThread?: boolean;
  /**
   * The last people who answered in this message's thread, most recent first: their faces are drawn
   * next to the reply count, which is how a thread shows who is in it before it is opened.
   */
  replyFaces?: { name: string; avatar?: string }[];
  /**
   * The reader is not in this channel: they may read it, its threads included, and nothing else. No
   * actions, no reactions of their own, no checklist to tick. The API refuses all of it from someone
   * outside the channel, so none of it is offered.
   */
  readOnly?: boolean;
};

const avatarBtn: CSSProperties = {
  border: 0,
  background: "none",
  padding: 0,
  cursor: "pointer",
  flex: "none",
  alignSelf: "flex-start",
};

const nameBtn: CSSProperties = {
  border: 0,
  background: "none",
  padding: 0,
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  fontWeight: 600,
  color: "var(--text-strong)",
};

export function MessageRow({
  m,
  authorPresence,
  authorAvatar,
  grouped = false,
  endsRun = true,
  readBy,
  readAudience = 0,
  actions,
  canPin = true,
  importedFrom,
  inThread = false,
  replyFaces,
  readOnly = false,
}: MessageRowProps) {
  const { t } = useTranslation();
  // API rows carry the complete arrays. The singular fields remain compatibility aliases for old
  // fixture rows and compact callers, and must not hide the rest of a multi-file message.
  const images = m.images ?? (m.image ? [m.image] : []);
  const attachments = m.attachments ?? (m.attachment ? [m.attachment] : []);
  const [hoverState, setHover] = useState(false);
  // A finger has no hover: a tap sends a synthetic mouseenter that would leave the toolbar and the
  // highlight stuck on the last message touched. On touch, the actions are a press and hold away.
  const touch = useTouch();
  const hover = hoverState && !touch;
  const [sheetOpen, setSheetOpen] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const pressAt = useRef<{ x: number; y: number } | null>(null);
  const cancelPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressAt.current = null;
  };
  const [reactOpen, setReactOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const avatarRef = useRef<HTMLButtonElement>(null);
  // A mention opens the same card as the author's avatar, hung under the mention itself. Clicking
  // one used to replace the right panel with the full profile, which is a lot to lose (a thread, the
  // members) for a glance at who someone is; the card offers the full profile as its next step.
  // The clicked element is held in state (the body is drawn by a render helper, which may not touch
  // a ref) and mirrored into a ref for the popover's outside-click test, which runs on events only.
  const [mentionOpen, setMentionOpen] = useState<{ name: string; anchor: HTMLElement } | null>(null);
  const mention = mentionOpen?.name ?? null;
  const mentionRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    mentionRef.current = mentionOpen?.anchor ?? null;
  }, [mentionOpen]);
  // The card opens once its profile is in hand, so it is placed at its final size rather than
  // growing (and jumping) after it appears. A failed read still opens it, on the name alone.
  const openMention = (name: string, anchor: HTMLElement) => {
    if (mentionOpen?.anchor === anchor) {
      setMentionOpen(null);
      return;
    }
    const userId = actions.mentionUserId(name);
    const open = () => setMentionOpen({ name, anchor });
    if (!userId) open();
    else prefetchProfile(userId).then(open, open);
  };
  const setMention = (next: null) => setMentionOpen(next);
  const deleted = m.deleted;
  const me = getCurrentUser().name;
  const isOwn = m.author === me;
  // Highlight messages that @-mention the current user (by full or first name), Slack-style. Not our
  // own messages, and never a deleted tombstone.
  const firstName = me.split(" ")[0];
  const mentionsMe =
    !isOwn &&
    !deleted &&
    m.kind !== "system" &&
    !!me &&
    (m.body.includes(`@${me}`) || (firstName.length > 1 && m.body.includes(`@${firstName}`)));
  const showActions = (hover || reactOpen || menuOpen) && !deleted && !readOnly && !touch;

  /**
   * What the gutter of a continued message shows: the hour, and only the hour.
   *
   * `m.time` is written for the header of a block and says as much as that position needs: "17:45"
   * today, "Hier, 17:45", or a bare date further back. In a gutter 34 pixels wide those longer
   * forms wrapped onto a second line and moved every message under them. They are also redundant
   * there: a block spans five minutes, so its header has already said which day, and the only thing
   * that changes from one line to the next is the time of day.
   */
  const gutterTime = formatTime(m.createdAt);

  const openProfileFromCard = () => {
    setProfileOpen(false);
    actions.onOpenProfile();
  };
  const editProfileFromCard = () => {
    setProfileOpen(false);
    actions.onEditProfile();
  };
  const messageFromCard = () => {
    setProfileOpen(false);
    actions.onMessage();
  };

  return (
    <div
      data-mid={m.id}
      className={m.fresh ? "wc-enter" : undefined}
      style={{
        ...styles.msg,
        // The two halves of the gap are decided separately, because they answer different questions.
        // Above: is this line continuing the one before it. Below: is anything continuing this one,
        // which is also what says whether the hover receipt needs room. Tying the bottom to
        // "grouped" instead left the full reserve under the *first* line of a block, so a run opened
        // with a gap its own members did not have.
        padding: `${grouped ? 2 : 6}px 8px ${endsRun ? 18 : 4}px`,
        // A message that mentions the current user is washed in the theme's pastel: the colour that
        // means "yours" everywhere else (the open conversation, one's own reaction).
        background: deleted
          ? "transparent"
          : sheetOpen
            ? "var(--surface-selected)"
            : hover
            ? "var(--surface-hover)"
            : mentionsMe
              ? "var(--surface-mention)"
              : "transparent",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // Press and hold, on a touch screen: the message's actions rise from the bottom. A finger
      // that moves is scrolling, not pressing, and lets go of the press.
      onPointerDown={(e) => {
        if (e.pointerType !== "touch" || deleted || readOnly || m.kind === "system") return;
        pressAt.current = { x: e.clientX, y: e.clientY };
        pressTimer.current = window.setTimeout(() => {
          pressTimer.current = null;
          haptic("medium");
          setSheetOpen(true);
          // Lifting the finger sends a click where it was, which is now on the sheet: it would press
          // whatever row rose under it. The next click, within a moment, is swallowed.
          const swallow = (ev: MouseEvent) => {
            ev.stopPropagation();
            ev.preventDefault();
          };
          window.addEventListener("click", swallow, { capture: true, once: true });
          window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 700);
        }, 450);
      }}
      onPointerMove={(e) => {
        const at = pressAt.current;
        if (at && Math.hypot(e.clientX - at.x, e.clientY - at.y) > 10) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      // The browser's own long-press menu (select, copy, share) would open on top of ours.
      onContextMenu={touch ? (e) => e.preventDefault() : undefined}
    >
      {grouped ? (
        <span style={styles.gutterTime} aria-hidden={!hover}>
          {hover ? gutterTime : ""}
        </span>
      ) : (
        <button
          ref={avatarRef}
          style={avatarBtn}
          // Read ahead on hover, so the card opens at its final size (see `prefetchProfile`).
          onMouseEnter={() => {
            if (m.authorId) prefetchProfile(m.authorId).catch(() => {});
          }}
          onClick={() => setProfileOpen((o) => !o)} aria-label={t("profile.of", { name: m.author })}>
          <Avatar
            name={m.author}
            src={authorAvatar}
            size={34}
            presence={m.kind === "system" ? undefined : (authorPresence ?? getPresence(m.author))}
          />
        </button>
      )}
      <Popover anchorRef={avatarRef} open={profileOpen} onClose={() => setProfileOpen(false)} placement="bottom" align="start">
        <UserProfileCard name={m.author} userId={m.authorId} presence={authorPresence} onViewFull={openProfileFromCard} onEditProfile={editProfileFromCard} onMessage={messageFromCard} />
      </Popover>
      <Popover
        anchorRef={mentionRef}
        getAnchorRect={() => mentionOpen?.anchor.getBoundingClientRect() ?? null}
        open={mention !== null}
        onClose={() => setMention(null)}
        placement="bottom"
        align="start"
      >
        {mention !== null ? (
          <UserProfileCard
            name={mention}
            userId={actions.mentionUserId(mention)}
            presence={getPresence(mention)}
            onViewFull={() => {
              setMention(null);
              actions.onOpenMention(mention);
            }}
            onEditProfile={() => {
              setMention(null);
              actions.onEditMentionProfile(mention);
            }}
            onMessage={() => {
              setMention(null);
              actions.onMessageMention(mention);
            }}
          />
        ) : null}
      </Popover>
      <div style={{ flex: 1, minWidth: 0 }}>
        {grouped ? null : (
        <div style={styles.author}>
          <button style={nameBtn} onClick={() => setProfileOpen(true)}>
            {m.author}
          </button>
          <span style={styles.time}>{formatStamp(m.createdAt)}</span>
          {!deleted && m.imported ? (
            (() => {
              const brand = brandFor(importedFrom);
              return (
                <Tag brand={brand ?? undefined} icon={brand ? undefined : "import"}>
                  {t("common.imported")}
                </Tag>
              );
            })()
          ) : null}
          {!deleted && m.pinned ? (
            <Tag icon="pin" tone="accent">
              {t("message.pinnedTag")}
            </Tag>
          ) : null}
          {!deleted && m.saved ? (
            <Tag icon="bookmark" tone="accent">
              {t("message.savedTag")}
            </Tag>
          ) : null}
        </div>
        )}

        {deleted ? (
          <p
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 14,
              fontStyle: "italic",
              color: "var(--text-subtle)",
              marginTop: 1,
            }}
          >
            <Icon name="trash-2" size={14} />
            {t("message.deleted")}
          </p>
        ) : (
          <>
            {m.body ? (
              <div style={styles.body}>
                {renderRichText(
                  m.body,
                  getMentionNames(),
                  isOwn,
                  openMention,
                  me,
                  { names: getSpaceRooms(), onOpen: actions.onOpenRoom },
                  // Only your own checklist is yours to tick: the API refuses an edit from anyone
                  // but the author, and a box that answers a click with a toast is worse than one
                  // that says up front it is not yours.
                  isOwn && !readOnly ? actions.onToggleTask : undefined,
                )}
                {m.edited ? <EditedTag createdAt={m.createdAt} editedAt={m.editedAt} /> : null}
              </div>
            ) : null}

            {m.link ? <LinkPreviewCard link={m.link} /> : null}
            {images.map((image, index) => (
              <InlineImage key={image.fileId ?? `${image.alt}-${index}`} image={image} />
            ))}

            {attachments.map((attachment, index) => (
              <AttachmentCard key={attachment.fileId ?? `${attachment.name}-${index}`} attachment={attachment} />
            ))}

            {m.reactions && m.reactions.length > 0 ? (
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                {m.reactions.map((r) => (
                  <ReactionPill
                    key={r.emoji}
                    emoji={r.emoji}
                    count={r.count}
                    mine={r.mine}
                    users={r.users}
                    style={reactionPill(r.mine)}
                    onClick={readOnly ? undefined : () => actions.onReact(r.emoji)}
                  />
                ))}
                {readOnly ? null : <ReactionMenu variant="pill" onPick={actions.onReact} />}
              </div>
            ) : null}

            {/* Inside the thread panel the root's own count is already the separator below it, and
                the button would reopen what is open. */}
            {m.replies && !inThread ? (
              <button
                onClick={actions.onOpenThread}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 8,
                  border: 0,
                  background: "none",
                  padding: 0,
                  cursor: "pointer",
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--text-link)",
                }}
              >
                {/* Who answered, before what was answered: a thread is worth opening because of who
                    is in it. The icon stands in while the faces are unknown (an old client, a
                    thread whose replies were all taken back). */}
                {replyFaces && replyFaces.length > 0 ? (
                  <span style={{ display: "inline-flex", alignItems: "center" }}>
                    {replyFaces.map((face, i) => (
                      <span key={face.name} style={{ marginLeft: i === 0 ? 0 : -6, display: "inline-flex" }}>
                        <Avatar name={face.name} src={face.avatar} size={20} />
                      </span>
                    ))}
                  </span>
                ) : (
                  <Icon name="message-square" size={14} />
                )}
                {/* Underlined in the accent, thick, as every link; the time beside it is not. */}
                <span style={{ textDecoration: "underline", textDecorationColor: "var(--acc)", textDecorationThickness: 2, textUnderlineOffset: 3 }}>
                  {t("message.replies", { count: m.replies })}
                </span>
                {/* How fresh the thread is, which is what decides whether it is worth opening now. */}
                {m.lastReplyAt ? (
                  <span style={{ fontWeight: 400, fontSize: 12, color: "var(--text-muted)" }}>
                    {t("message.lastReply", { when: formatRelativeStamp(m.lastReplyAt) })}
                  </span>
                ) : null}
              </button>
            ) : null}
          </>
        )}
      </div>

      {/*
        Only under our own messages. "Has this been read" is a question about something you sent;
        under someone else's it reports on third parties to no purpose, which is how it came to be
        shown everywhere saying "Lu" with nothing behind it.
      */}
      {hover && !deleted && isOwn ? (
        <div style={styles.receipt}>
          <ReadReceipt names={readBy} audience={readAudience} />
        </div>
      ) : null}

      {showActions ? (
        // Where it floats depends on what is above. The first line of a block has the room left under
        // the block before it (see the row's bottom padding), so the bar sits there, over the seam.
        // A line continuing a block has no such room: raised, the bar covered the end of the line
        // above, which belongs to another message, so it stays on the row's own first line instead.
        <div style={{ ...styles.actions, top: grouped ? 2 : -14 }}>
          <ReactionMenu variant="action" onPick={actions.onReact} onOpenChange={setReactOpen} />
          {inThread ? null : (
            <Tooltip label={t("message.replyInThread")} side="top">
              <IconButton icon="message-square" label={t("message.replyInThread")} size="sm" onClick={actions.onOpenThread} />
            </Tooltip>
          )}
          {isOwn ? (
            <Tooltip label={t("message.edit")} side="top">
              <IconButton icon="square-pen" label={t("message.edit")} size="sm" onClick={actions.onEdit} />
            </Tooltip>
          ) : null}
          <Tooltip label={m.saved ? t("message.unsave") : t("message.save")} side="top">
            <IconButton
              icon="bookmark"
              label={m.saved ? t("message.unsave") : t("message.save")}
              size="sm"
              aria-pressed={m.saved}
              onClick={actions.onToggleSave}
            />
          </Tooltip>
          <MessageMenu
            canPin={canPin}
            pinned={m.pinned}
            own={isOwn}
            sentAt={formatDateTime(m.createdAt)}
            hasReactions={!!m.reactions?.length}
            onShowReactions={() => setReactionsOpen(true)}
            onEdit={actions.onEdit}
            onCopyMessage={actions.onCopyMessage}
            onCopyLink={actions.onCopyLink}
            onTogglePin={actions.onTogglePin}
            onMarkUnread={inThread ? undefined : actions.onMarkUnread}
            onDelete={actions.onDelete}
            onOpenChange={setMenuOpen}
          />
        </div>
      ) : null}

      {sheetOpen ? (
        <MessageActionSheet
          open
          onClose={() => setSheetOpen(false)}
          sentAt={formatDateTime(m.createdAt)}
          own={isOwn}
          saved={m.saved}
          pinned={m.pinned}
          canPin={canPin}
          inThread={inThread}
          hasReactions={!!m.reactions?.length}
          onReact={actions.onReact}
          onOpenThread={actions.onOpenThread}
          onToggleSave={actions.onToggleSave}
          onEdit={actions.onEdit}
          onCopyMessage={actions.onCopyMessage}
          onCopyLink={actions.onCopyLink}
          onTogglePin={actions.onTogglePin}
          onMarkUnread={actions.onMarkUnread}
          onShowReactions={() => setReactionsOpen(true)}
          onDelete={actions.onDelete}
        />
      ) : null}

      {reactionsOpen ? (
        <Dialog title={t("message.reactions")} size="sm" onClose={() => setReactionsOpen(false)} closeLabel={t("common.close")}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {m.reactions?.map((r) => (
              <div
                key={r.emoji}
                style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 2px", borderBottom: "1px solid var(--border-subtle)" }}
              >
                <span style={{ fontSize: 22, lineHeight: 1 }}>{r.emoji}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
                    {t("message.reactors", { count: r.count })}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                    {r.users && r.users.length > 0 ? r.users.join(", ") : "—"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * The "(modifié)" beside an edited body.
 *
 * An edit made the day the message was sent needs no date: the header above already says which day
 * it is. One made on a later day does, or yesterday's message reads as yesterday's text when it
 * changed this morning, so the tag carries when ("(modifié aujourd'hui, 10:12)"). Either way the
 * exact moment is on hover. Rows that predate `editedAt` (an optimistic row, an old payload) keep
 * the bare tag.
 */
function EditedTag({ createdAt, editedAt }: { createdAt: string; editedAt?: string }) {
  const { t } = useTranslation();
  if (!editedAt) {
    return (
      <span style={styles.editedLine}>
        <span style={styles.edited}>{t("message.editedTag")}</span>
      </span>
    );
  }
  const label = isSameDay(createdAt, editedAt)
    ? t("message.editedTag")
    : t("message.editedTagWhen", { when: formatRelativeStamp(editedAt) });
  return (
    // Its own line under the body: after a long last line, inline, it read as part of the text.
    <span style={styles.editedLine}>
      <Tooltip label={t("message.editedAt", { at: formatDateTime(editedAt) })}>
        <span style={styles.edited}>{label}</span>
      </Tooltip>
    </span>
  );
}
