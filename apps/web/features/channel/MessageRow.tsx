"use client";

import { type CSSProperties, useRef, useState } from "react";
import { Avatar, brandFor, Card, Dialog, FileIcon, Icon, IconButton, IconLink, Popover, Tag } from "@/components/ds";
import { getCurrentUser, getMentionNames, getPresence, getSpaceRooms } from "@/lib/data";
import type { ImportSource, Message, MessageAttachment } from "@/lib/data";
import type { Presence } from "@/components/ds";
import { ReactionPill } from "./ReactionPill";
import { UserProfileCard } from "../app/UserProfileCard";
import { renderRichText } from "./richText";
import { InlineImage } from "./InlineImage";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { MessageMenu } from "./MessageMenu";
import { ReactionMenu } from "./ReactionMenu";
import { ReadReceipt } from "./ReadReceipt";
import { useTranslation } from "@/lib/i18n";
import { formatBytes, formatDateTime, formatStamp, formatTime } from "@/lib/i18n/format";

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
  /** Open the profile of a user @-mentioned in the body. */
  onOpenMention: (name: string) => void;
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
  name: { fontSize: 14, fontWeight: 600, color: "var(--text-strong)" },
  time: { fontSize: 13, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" },
  body: {
    fontSize: 16,
    lineHeight: "var(--leading-normal)",
    color: "var(--text-body)",
    marginTop: 1,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  edited: { marginLeft: 6, fontSize: 12, color: "var(--text-subtle)" },
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
    top: -14,
    right: 8,
    display: "flex",
    gap: 2,
    padding: 2,
    background: "var(--surface-canvas)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-popover)",
  },
  receipt: {
    position: "absolute",
    right: 12,
    bottom: 6,
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
            border: "1px dashed var(--border-default)",
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
    height: 26,
    padding: "0 9px",
    border: `1px solid ${mine ? "var(--border-accent)" : "var(--border-default)"}`,
    background: mine ? "var(--surface-selected)" : "var(--surface-canvas)",
    borderRadius: "var(--radius-full)",
    fontSize: 13,
    color: mine ? "var(--text-accent)" : "var(--text-muted)",
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
  const [hover, setHover] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const avatarRef = useRef<HTMLButtonElement>(null);
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
  const showActions = (hover || reactOpen || menuOpen) && !deleted && !readOnly;

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
        // The rail is a straight edge, so the corners it runs along are straight too. Rounded ones
        // pinched it at both ends, and broke the line where two highlighted messages meet.
        ...(mentionsMe ? { borderRadius: "0 var(--radius-md) var(--radius-md) 0" } : {}),
        background: deleted
          ? "transparent"
          : hover
            ? "var(--surface-hover)"
            : mentionsMe
              ? "var(--surface-mention, rgba(198, 93, 69, 0.07))"
              : "transparent",
        // A terracotta rail on the left marks a message that mentions the current user.
        ...(mentionsMe ? { boxShadow: "inset 3px 0 0 0 var(--terracotta-500)" } : {}),
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {grouped ? (
        <span style={styles.gutterTime} aria-hidden={!hover}>
          {hover ? gutterTime : ""}
        </span>
      ) : (
        <button ref={avatarRef} style={avatarBtn} onClick={() => setProfileOpen((o) => !o)} aria-label={t("profile.of", { name: m.author })}>
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
                  actions.onOpenMention,
                  me,
                  { names: getSpaceRooms(), onOpen: actions.onOpenRoom },
                  // Only your own checklist is yours to tick: the API refuses an edit from anyone
                  // but the author, and a box that answers a click with a toast is worse than one
                  // that says up front it is not yours.
                  isOwn && !readOnly ? actions.onToggleTask : undefined,
                )}
                {m.edited ? <span style={styles.edited}>{t("message.editedTag")}</span> : null}
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
                  fontWeight: 500,
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
                {t("message.replies", { count: m.replies })}
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
        <div style={styles.actions}>
          <ReactionMenu variant="action" onPick={actions.onReact} onOpenChange={setReactOpen} />
          {inThread ? null : (
            <IconButton icon="message-square" label={t("message.replyInThread")} size="sm" onClick={actions.onOpenThread} />
          )}
          {isOwn ? <IconButton icon="square-pen" label={t("message.edit")} size="sm" onClick={actions.onEdit} /> : null}
          <IconButton
            icon="bookmark"
            label={m.saved ? t("message.unsave") : t("message.save")}
            size="sm"
            aria-pressed={m.saved}
            onClick={actions.onToggleSave}
          />
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
