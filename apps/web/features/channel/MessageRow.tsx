"use client";

import { type CSSProperties, useRef, useState } from "react";
import { Avatar, Card, Dialog, Icon, IconButton, IconLink, Popover, Tag } from "@/components/ds";
import { getCurrentUser, getMentionNames, getPresence } from "@/lib/data";
import type { Message } from "@/lib/data";
import type { Presence } from "@/components/ds";
import { ReactionPill } from "./ReactionPill";
import { UserProfileCard } from "../app/UserProfileCard";
import { renderRichText } from "./richText";
import { InlineImage } from "./InlineImage";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { MessageMenu } from "./MessageMenu";
import { ReactionMenu } from "./ReactionMenu";
import { ReadReceipt } from "./ReadReceipt";

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
    // "17:45" fits 34px by a hair, and the hair ran out: it wrapped onto a second line, which made
    // the row taller and pushed every message below it down for as long as the cursor stayed there.
    // A time is one line by nature, so it is told so rather than given more room.
    whiteSpace: "nowrap",
    overflow: "hidden",
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
}: MessageRowProps) {
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
  const showActions = (hover || reactOpen || menuOpen) && !deleted;

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
          {hover ? m.time : ""}
        </span>
      ) : (
        <button ref={avatarRef} style={avatarBtn} onClick={() => setProfileOpen((o) => !o)} aria-label={`Profil de ${m.author}`}>
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
          <span style={styles.time}>{m.time}</span>
          {!deleted && m.imported ? <Tag icon="import">Importé</Tag> : null}
          {!deleted && m.pinned ? (
            <Tag icon="pin" tone="accent">
              Épinglé
            </Tag>
          ) : null}
          {!deleted && m.saved ? (
            <Tag icon="bookmark" tone="accent">
              Enregistré
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
            Message supprimé
          </p>
        ) : (
          <>
            {m.body ? (
              <div style={styles.body}>
                {renderRichText(m.body, getMentionNames(), isOwn, actions.onOpenMention, me)}
                {m.edited ? <span style={styles.edited}>(modifié)</span> : null}
              </div>
            ) : null}

            {m.link ? <LinkPreviewCard link={m.link} /> : null}
            {m.image ? <InlineImage image={m.image} /> : null}

            {m.attachment ? (
              <div style={{ marginTop: 8, maxWidth: 360 }}>
                <Card
                  variant="interactive"
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px" }}
                >
                  <Icon name={m.attachment.kind} size={18} style={{ color: "var(--text-muted)" }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: "var(--text-strong)" }}>
                      {m.attachment.name}
                    </span>
                    <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                      {m.attachment.size}
                    </span>
                  </span>
                  {m.attachment.url ? (
                    <>
                      {/* The original bytes, inline: full quality, and the browser's own viewer. */}
                      <IconLink
                        icon="external-link"
                        label={`Ouvrir ${m.attachment.name} dans un nouvel onglet`}
                        size="sm"
                        href={m.attachment.previewUrl ?? m.attachment.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      />
                      <IconLink
                        icon="download"
                        label={`Télécharger ${m.attachment.name}`}
                        size="sm"
                        href={m.attachment.url}
                        download={m.attachment.name}
                      />
                    </>
                  ) : (
                    // Still uploading: nothing to fetch yet.
                    <IconButton icon="download" label="Télécharger" size="sm" disabled />
                  )}
                </Card>
              </div>
            ) : null}

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
                    onClick={() => actions.onReact(r.emoji)}
                  />
                ))}
                <ReactionMenu variant="pill" onPick={actions.onReact} />
              </div>
            ) : null}

            {m.replies ? (
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
                <Icon name="message-square" size={14} />
                {m.replies} réponses
                <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>· dernière il y a 12 min</span>
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
          <IconButton icon="message-square" label="Répondre dans un fil" size="sm" onClick={actions.onOpenThread} />
          {isOwn ? <IconButton icon="square-pen" label="Modifier" size="sm" onClick={actions.onEdit} /> : null}
          <IconButton
            icon="bookmark"
            label={m.saved ? "Retirer des enregistrés" : "Enregistrer"}
            size="sm"
            aria-pressed={m.saved}
            onClick={actions.onToggleSave}
          />
          <MessageMenu
            pinned={m.pinned}
            own={isOwn}
            sentAt={`aujourd'hui à ${m.time}`}
            hasReactions={!!m.reactions?.length}
            onShowReactions={() => setReactionsOpen(true)}
            onEdit={actions.onEdit}
            onCopyMessage={actions.onCopyMessage}
            onCopyLink={actions.onCopyLink}
            onTogglePin={actions.onTogglePin}
            onMarkUnread={actions.onMarkUnread}
            onDelete={actions.onDelete}
            onOpenChange={setMenuOpen}
          />
        </div>
      ) : null}

      {reactionsOpen ? (
        <Dialog title="Réactions" size="sm" onClose={() => setReactionsOpen(false)}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {m.reactions?.map((r) => (
              <div
                key={r.emoji}
                style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 2px", borderBottom: "1px solid var(--border-subtle)" }}
              >
                <span style={{ fontSize: 22, lineHeight: 1 }}>{r.emoji}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
                    {r.count} {r.count > 1 ? "personnes" : "personne"}
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
