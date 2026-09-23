"use client";

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { Icon, IconButton, Popover } from "@/components/ds";
import type { Presence } from "@/components/ds";
import type { Message, MessageAttachment } from "@/lib/data";
import { deleteFile } from "@/lib/data/api";
import { formatBytes } from "@/lib/i18n/format";
import { EmojiPicker } from "./EmojiPicker";
import { MessageEditor, type MessageEditorHandle } from "./MessageEditor";
import { MessageRow, type MessageActions } from "./MessageRow";
import { useStickToBottom } from "./useStickToBottom";
import { THREAD_WIDTH_MAX, THREAD_WIDTH_MIN, useSettings } from "../app/settings";
import { useTranslation } from "@/lib/i18n";
import type { Toast } from "../app/types";

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
    borderRadius: "var(--radius-lg)",
    background: "var(--surface-canvas)",
    padding: "8px 10px",
  },
  editingBanner: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
    fontSize: 12,
    color: "var(--text-muted)",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    padding: "4px 6px",
    fontSize: 12,
  },
};

export type ThreadPanelProps = {
  parent: Message;
  /** The thread's replies, oldest first, held with the rest of the conversation. */
  replies: Message[];
  /** Build a row's actions, so a reply is acted on exactly like a message in the feed. */
  rowActions: (m: Message) => MessageActions;
  /** Live presence by display name, for the row avatars. */
  presenceByName: Map<string, Presence>;
  /** Uploaded avatars by display name; absent means the generated one. */
  avatarByName: Map<string, string | undefined>;
  /** Post a reply in this thread. */
  onSendReply: (text: string) => void;
  /** Set while one of *these* messages is being edited: the thread composer takes the edit. */
  editing?: { id: string; body: string } | null;
  onSaveEdit?: (text: string, attachments?: MessageAttachment[]) => void;
  onCancelEdit?: () => void;
  /** Store a file selected while editing a reply. */
  onUpload: (file: File) => Promise<MessageAttachment>;
  onNotify: (toast: Toast) => void;
  onClose: () => void;
};

/**
 * Right-hand thread view: the root message, then its replies, drawn with the same row as the feed.
 *
 * A reply used to be a reduced row of its own (name, time, text) with nothing to act on: no
 * reaction, no edit, no deletion, not even a tombstone for one that had been taken back. A reply is
 * the same kind of thing as a message in the channel, so it is drawn by the same component, minus
 * what only the feed can mean (see `inThread` on the row).
 */
export function ThreadPanel({
  parent,
  replies,
  rowActions,
  presenceByName,
  avatarByName,
  onSendReply,
  editing,
  onSaveEdit,
  onCancelEdit,
  onUpload,
  onNotify,
  onClose,
}: ThreadPanelProps) {
  const { t } = useTranslation();
  const settings = useSettings();
  // The dragged width is kept in the preferences, so a thread reopens as wide as it was left. Local
  // while the handle is held: storing on every mouse move would write a hundred intermediate widths
  // to keep the last one.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? settings.threadWidth;
  // A thread reads like the main feed: it follows its latest reply while the reader is at the end
  // of it. It had no scrolling of its own at all, so a reply arriving in an open thread stayed
  // below the fold.
  const { ref: scrollRef } = useStickToBottom<HTMLDivElement>(parent.id);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const editorRef = useRef<MessageEditorHandle>(null);
  const emojiRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [editPending, setEditPending] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const activeUploads = useRef(0);

  // Tombstones stay on screen (a thread reads as it happened) but are not replies any more, so this
  // count says the same thing as the one the feed draws under the root message.
  const liveReplies = replies.filter((r) => !r.deleted).length;

  // Load the message being edited into the editor, and restore an empty one when the edit ends.
  // Same contract as the channel composer, keyed on the id so switching messages swaps the text.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (editingId) ed.setText(editing?.body ?? "");
    else ed.clear();
  }, [editingId, editing?.body]);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      let latest = startWidth;
      const onMove = (ev: MouseEvent) => {
        latest = Math.min(THREAD_WIDTH_MAX, Math.max(THREAD_WIDTH_MIN, startWidth - (ev.clientX - startX)));
        setDragWidth(latest);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        settings.set("threadWidth", latest);
        setDragWidth(null);
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [width, settings],
  );

  const submit = (text: string): boolean => {
    if (activeUploads.current > 0) return false;
    if (editing) {
      onSaveEdit?.(text, editPending.length ? editPending : undefined);
      setEditPending([]);
      return true;
    }
    onSendReply(text);
    return true;
  };

  const discardEditFiles = () => {
    for (const attachment of editPending) {
      if (attachment.fileId) void deleteFile(attachment.fileId).catch(() => {});
    }
    setEditPending([]);
  };

  const cancelEdit = () => {
    discardEditFiles();
    onCancelEdit?.();
  };

  const addFiles = async (files: File[]) => {
    if (!editing || files.length === 0) return;
    if (fileRef.current) fileRef.current.value = "";
    activeUploads.current += 1;
    setUploading(true);
    try {
      for (const file of files) {
        const provisional: MessageAttachment = { name: file.name, sizeBytes: file.size, kind: file.type.startsWith("image") ? "image" : "file" };
        setEditPending((current) => [...current, provisional]);
        try {
          const stored = await onUpload(file);
          setEditPending((current) => current.map((attachment) => attachment === provisional ? stored : attachment));
        } catch {
          setEditPending((current) => current.filter((attachment) => attachment !== provisional));
          onNotify({ tone: "danger", title: t("composer.uploadFailed"), description: t("composer.uploadFailedName", { name: file.name }) });
        }
      }
    } finally {
      activeUploads.current -= 1;
      setUploading(activeUploads.current > 0);
    }
  };

  const clickSend = () => {
    const editor = editorRef.current;
    if (!editor || activeUploads.current > 0) return;
    if (editing && editPending.length > 0 && editor.isEmpty()) {
      submit("");
      editor.clear();
      editor.focus();
      return;
    }
    editor.submit();
  };

  const row = (m: Message) => (
    <MessageRow
      key={m.id}
      m={m}
      inThread
      canPin={false}
      authorPresence={presenceByName.get(m.author)}
      authorAvatar={avatarByName.get(m.author)}
      actions={rowActions(m)}
    />
  );

  return (
    <div style={{ ...styles.panel, width }}>
      <div style={styles.handle} onMouseDown={startResize} role="separator" aria-orientation="vertical" />
      <div style={styles.head}>
        <span style={styles.title}>{t("thread.title")}</span>
        <IconButton icon="x" label={t("thread.close")} size="sm" onClick={onClose} />
      </div>
      <div style={styles.scroll} ref={scrollRef}>
        {/* The root is a message of the feed, drawn here as the thread's first row: offering to open
            a thread from inside the one it already opened would go nowhere. */}
        {row(parent)}
        <div style={styles.count}>
          <span style={styles.countLine} />
          {t("message.replies", { count: liveReplies })}
          <span style={styles.countLine} />
        </div>
        {replies.map(row)}
      </div>
      <div style={styles.composer}>
        <div className="wc-message-composer" style={styles.composerBox}>
          {editing ? (
            <div style={styles.editingBanner}>
              <Icon name="square-pen" size={14} style={{ color: "var(--text-accent)" }} />
              <span style={{ fontWeight: 600, color: "var(--text-accent)" }}>{t("composer.editing")}</span>
              <span style={{ color: "var(--text-subtle)" }}>{t("composer.escToCancel")}</span>
              <div style={{ flex: 1 }} />
              <IconButton icon="x" label={t("composer.cancelEdit")} size="sm" onClick={cancelEdit} />
            </div>
          ) : null}
          <div
            onKeyDown={(e) => {
              if (editing && e.key === "Escape") {
                e.stopPropagation();
                cancelEdit();
              }
            }}
          >
            <MessageEditor
              ref={editorRef}
              placeholder={editing ? t("message.editMessage") : t("thread.replyPlaceholder")}
              onSend={submit}
              onPasteFiles={(files) => void addFiles(files)}
            />
          </div>
          {editing && editPending.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {editPending.map((attachment, index) => (
                <div key={`${attachment.name}-${index}`} style={styles.chip}>
                  <Icon name={attachment.kind} size={16} />
                  <span>{attachment.name}</span>
                  <span style={{ color: "var(--text-subtle)" }}>{attachment.fileId ? formatBytes(attachment.sizeBytes) : t("composer.uploading")}</span>
                  <IconButton icon="x" label={t("composer.removeAttachment")} size="sm" disabled={!attachment.fileId} onClick={() => {
                    if (attachment.fileId) void deleteFile(attachment.fileId).catch(() => {});
                    setEditPending((current) => current.filter((_, currentIndex) => currentIndex !== index));
                  }} />
                </div>
              ))}
            </div>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 2, marginTop: 4 }}>
            {editing ? (
              <>
                <IconButton icon="paperclip" label={t("composer.attach")} size="sm" onClick={() => fileRef.current?.click()} />
                <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={(event) => void addFiles(Array.from(event.target.files ?? []))} />
              </>
            ) : null}
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
            <IconButton icon="send" label={t("composer.send")} variant="accent" size="sm" disabled={uploading} onClick={clickSend} />
          </div>
        </div>
      </div>
    </div>
  );
}
