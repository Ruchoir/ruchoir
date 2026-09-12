"use client";

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { Avatar, IconButton, Popover } from "@/components/ds";
import { getAvatar, getCurrentUser } from "@/lib/data";
import type { Message } from "@/lib/data";
import { getReplies, sendMessage } from "@/lib/data/api";
import { EmojiPicker } from "./EmojiPicker";
import { MessageEditor, type MessageEditorHandle } from "./MessageEditor";
import { useStickToBottom } from "./useStickToBottom";
import { useTranslation } from "@/lib/i18n";

const MIN_WIDTH = 320;
const MAX_WIDTH = 720;

const styles: Record<string, CSSProperties> = {
  panel: {
    flex: "none",
    position: "relative",
    borderLeft: "1px solid var(--border-subtle)",
    background: "var(--surface-chrome)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  handle: {
    position: "absolute",
    left: -3,
    top: 0,
    bottom: 0,
    width: 6,
    cursor: "col-resize",
    zIndex: 2,
  },
  head: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px 0 16px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  title: { fontSize: 14, fontWeight: 600, color: "var(--text-strong)" },
  scroll: { flex: 1, overflow: "auto", padding: "12px 16px" },
  reply: { display: "flex", gap: 10, padding: "8px 0" },
  name: { fontSize: 13, fontWeight: 600, color: "var(--text-strong)" },
  time: { fontSize: 12, color: "var(--text-muted)", marginLeft: 6 },
  body: { fontSize: 14, color: "var(--text-body)", lineHeight: "var(--leading-snug)", marginTop: 1 },
  count: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    margin: "12px 0",
    fontSize: 12,
    color: "var(--text-subtle)",
  },
  countLine: { flex: 1, height: 1, background: "var(--border-subtle)" },
  composer: {
    flex: "none",
    borderTop: "1px solid var(--border-subtle)",
    padding: 12,
  },
  composerBox: {
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-lg)",
    background: "var(--surface-canvas)",
    padding: "8px 10px",
  },
};

type Reply = { id: string; author: string; time: string; body: string };

/** Reduce a message to the fields the thread row renders. */
function toReply(m: { id: string; author: string; time: string; body: string }): Reply {
  return { id: m.id, author: m.author, time: m.time, body: m.body };
}

function ReplyRow({ r }: { r: Reply }) {
  return (
    <div style={styles.reply}>
      <Avatar name={r.author} src={getAvatar(r.author)} size={26} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>
          <span style={styles.name}>{r.author}</span>
          <span style={styles.time}>{r.time}</span>
        </div>
        <p style={styles.body}>{r.body}</p>
      </div>
    </div>
  );
}

export type ThreadPanelProps = {
  parent: Message;
  /** The conversation the thread belongs to (for posting replies). */
  conversationId: string;
  onClose: () => void;
};

/** Right-hand thread view for a message's replies, loaded from and posted to the API. */
export function ThreadPanel({ parent, conversationId, onClose }: ThreadPanelProps) {
  const { t } = useTranslation();
  const me = getCurrentUser().name;
  const [replies, setReplies] = useState<Reply[]>([]);
  const [width, setWidth] = useState(420);

  // Load the thread's replies whenever the parent changes.
  useEffect(() => {
    let active = true;
    getReplies(parent.id)
      .then((list) => active && setReplies(list.map(toReply)))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [parent.id]);
  // A thread reads like the main feed: it follows its latest reply while the reader is at the end
  // of it. It had no scrolling of its own at all, so a reply arriving in an open thread stayed
  // below the fold.
  const { ref: scrollRef } = useStickToBottom<HTMLDivElement>(parent.id);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const editorRef = useRef<MessageEditorHandle>(null);
  const emojiRef = useRef<HTMLButtonElement>(null);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth - (ev.clientX - startX)));
      setWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width]);

  const addReply = (text: string) => {
    if (!text.trim()) return;
    const tempId = `tmp-${Date.now()}`;
    setReplies((prev) => [
      ...prev,
      {
        id: tempId,
        author: me,
        time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
        body: text,
      },
    ]);
    sendMessage(conversationId, text, { parentMessageId: parent.id })
      .then((m) => setReplies((prev) => prev.map((r) => (r.id === tempId ? toReply(m) : r))))
      .catch(() => setReplies((prev) => prev.filter((r) => r.id !== tempId)));
  };

  return (
    <div style={{ ...styles.panel, width }}>
      <div style={styles.handle} onMouseDown={startResize} role="separator" aria-orientation="vertical" />
      <div style={styles.head}>
        <span style={styles.title}>{t("thread.title")}</span>
        <IconButton icon="x" label={t("thread.close")} size="sm" onClick={onClose} />
      </div>
      <div style={styles.scroll} ref={scrollRef}>
        <ReplyRow r={{ id: parent.id, author: parent.author, time: parent.time, body: parent.body }} />
        <div style={styles.count}>
          <span style={styles.countLine} />
          {replies.length} réponses
          <span style={styles.countLine} />
        </div>
        {replies.map((r) => (
          <ReplyRow key={r.id} r={r} />
        ))}
      </div>
      <div style={styles.composer}>
        <div style={styles.composerBox}>
          <MessageEditor ref={editorRef} placeholder={t("thread.replyPlaceholder")} onSend={addReply} />
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 2, marginTop: 4 }}>
            <IconButton
              ref={emojiRef}
              icon="smile"
              label={t("composer.emoji")}
              size="sm"
              aria-expanded={emojiOpen}
              onClick={() => setEmojiOpen((o) => !o)}
            />
            <Popover anchorRef={emojiRef} open={emojiOpen} onClose={() => setEmojiOpen(false)} placement="top" align="start">
              <EmojiPicker
                onPick={(emoji) => {
                  editorRef.current?.insertEmoji(emoji);
                  setEmojiOpen(false);
                }}
              />
            </Popover>
            <IconButton icon="send" label={t("composer.send")} variant="accent" size="sm" onClick={() => editorRef.current?.submit()} />
          </div>
        </div>
      </div>
    </div>
  );
}
