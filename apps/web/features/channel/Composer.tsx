"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Icon, IconButton, Popover } from "@/components/ds";
import type { MessageAttachment } from "@/lib/data";
import { deleteFile } from "@/lib/data/api";
import type { Toast } from "../app/types";
import { EmojiPicker } from "./EmojiPicker";
import { MessageEditor, type MessageEditorHandle } from "./MessageEditor";
import { useTranslation } from "@/lib/i18n";

const styles: Record<string, CSSProperties> = {
  wrap: { flex: "none", padding: "8px 24px 20px" },
  composer: {
    maxWidth: "var(--channel-measure)",
    margin: "0 auto",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-lg)",
    background: "var(--surface-canvas)",
    padding: "10px 12px 8px",
    transition: "border-color var(--duration-fast) var(--ease-out)",
  },
  editingBanner: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
    paddingBottom: 8,
    borderBottom: "1px solid var(--border-subtle)",
    fontSize: 12,
  },
  tools: { display: "flex", alignItems: "center", gap: 2, marginTop: 6 },
  hint: {
    maxWidth: "var(--channel-measure)",
    margin: "6px auto 0",
    fontSize: 12,
    color: "var(--text-subtle)",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 8px 6px 10px",
    marginBottom: 8,
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    background: "var(--surface-sunken)",
    fontSize: 13,
    color: "var(--text-body)",
  },
};

/** Format a byte count into a French-formatted size string. */
function bytesToSize(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1).replace(".", ",")} Mo`;
  return `${Math.max(1, Math.round(bytes / 1e3))} Ko`;
}

function iconForType(type: string): string {
  if (type.includes("spreadsheet") || type.includes("csv")) return "file-spreadsheet";
  if (type.startsWith("text")) return "file-text";
  if (type.startsWith("image")) return "image";
  return "file";
}

export type ComposerProps = {
  channelName: string;
  onSend: (text: string, attachment?: MessageAttachment) => void;
  /**
   * Store a picked file and resolve to the attachment the message will carry.
   *
   * The upload happens on pick and not on send, so a slow file does not block the message and a
   * refused one is reported while there is still something to do about it.
   */
  onUpload: (file: File) => Promise<MessageAttachment>;
  onNotify: (toast: Toast) => void;
  /** Emit a typing signal as the user composes (throttled here; the server throttles again). */
  onTyping?: () => void;
  /**
   * The message being edited, or nothing.
   *
   * Editing happens in the composer rather than in a dialog: it is the same act as writing, with
   * the same toolbar, the same emoji picker and the same `@` autocomplete, and a box floating over
   * the conversation hides the very thing being corrected. A banner says what is going on, since
   * text appearing in the composer by itself would otherwise be unexplained.
   */
  editing?: { id: string; body: string } | null;
  /** Save the edit with this text. */
  onSaveEdit?: (text: string) => void;
  /** Leave the edit without saving. */
  onCancelEdit?: () => void;
};

/** Message composer with a working formatting toolbar and file attachment. */
export function Composer({
  channelName,
  onSend,
  onUpload,
  onNotify,
  onTyping,
  editing,
  onSaveEdit,
  onCancelEdit,
}: ComposerProps) {
  const { t } = useTranslation();
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pending, setPending] = useState<MessageAttachment | null>(null);
  /** True from the moment a file is picked until it is stored (or refused). */
  const [uploading, setUploading] = useState(false);
  const editorRef = useRef<MessageEditorHandle>(null);
  const emojiRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);

  // Fire a typing signal at most every 2s while composing; input events bubble up from the editor.
  const signalTyping = () => {
    if (!onTyping) return;
    const now = Date.now();
    if (now - lastTyping.current < 2000) return;
    lastTyping.current = now;
    onTyping();
  };

  // Load the message being edited into the editor, and restore an empty one when the edit ends.
  // Keyed on the id so picking a different message while already editing swaps the text.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (editingId) ed.setText(editing?.body ?? "");
    else ed.clear();
  }, [editingId, editing?.body]);

  const sendWith = (text: string) => {
    if (editing) {
      onSaveEdit?.(text);
      return;
    }
    // A file still on its way has no id to attach, so the message waits rather than losing it.
    if (uploading) return;
    onSend(text, pending ?? undefined);
    setPending(null);
  };

  const clickSend = () => {
    const ed = editorRef.current;
    if (!ed || uploading) return;
    if (pending && ed.isEmpty()) {
      onSend("", pending);
      setPending(null);
      ed.clear();
      ed.focus();
      return;
    }
    ed.submit();
  };

  /**
   * Forget an attachment that was stored but never sent.
   *
   * The upload happens when the file is picked, so the bytes are in the space before the message
   * exists. Dropping the pick without sending used to leave them there: replacing one attachment
   * with another, or removing it, put a file in "Fichiers de l'espace" belonging to no message,
   * which nobody remembers uploading. Best-effort: a failed cleanup leaves exactly the state we
   * were leaving behind before.
   */
  const discardStored = (attachment: MessageAttachment | null) => {
    if (attachment?.fileId) void deleteFile(attachment.fileId).catch(() => {});
  };

  const onFilePicked = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    if (fileRef.current) fileRef.current.value = "";
    // A second pick replaces the first, which then has nothing left to belong to.
    discardStored(pending);
    // Show it immediately, with what the browser knows, then replace it with the stored file.
    setPending({ name: file.name, size: bytesToSize(file.size), kind: iconForType(file.type) });
    setUploading(true);
    try {
      setPending(await onUpload(file));
    } catch {
      setPending(null);
      onNotify({
        tone: "danger",
        title: t("composer.uploadFailed"),
        description: `« ${file.name} » n'a pas pu être téléversé.`,
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={styles.wrap}>
      <div
        style={{
          ...styles.composer,
          ...(editing ? { borderColor: "var(--border-accent)" } : {}),
        }}
        onInput={signalTyping}
        // Escape leaves an edit, which is the shortcut people reach for first. Caught here rather
        // than on the editor so it works from the toolbar and the emoji picker too.
        onKeyDown={(e) => {
          if (editing && e.key === "Escape") {
            e.stopPropagation();
            onCancelEdit?.();
          }
        }}
      >
        {editing ? (
          <div style={styles.editingBanner}>
            <Icon name="square-pen" size={14} style={{ color: "var(--text-accent)" }} />
            <span style={{ fontWeight: 600, color: "var(--text-accent)" }}>{t("composer.editing")}</span>
            <span style={{ color: "var(--text-subtle)" }}>{t("composer.escToCancel")}</span>
            <div style={{ flex: 1 }} />
            <IconButton icon="x" label={t("composer.cancelEdit")} size="sm" onClick={() => onCancelEdit?.()} />
          </div>
        ) : null}
        {pending && !editing ? (
          <div style={styles.chip}>
            <Icon name={pending.kind} size={16} style={{ color: "var(--text-muted)" }} />
            <span style={{ fontWeight: 500, color: "var(--text-strong)" }}>{pending.name}</span>
            <span style={{ color: "var(--text-subtle)" }}>{uploading ? "envoi…" : pending.size}</span>
            <IconButton
              icon="x"
              label={t("composer.removeAttachment")}
              size="sm"
              disabled={uploading}
              onClick={() => {
                discardStored(pending);
                setPending(null);
              }}
            />
          </div>
        ) : null}
        <MessageEditor
          ref={editorRef}
          placeholder={editing ? "Modifier le message" : `Écrire dans #${channelName}`}
          onSend={sendWith}
        />
        <div style={styles.tools}>
          <IconButton icon="bold" label={t("composer.bold")} size="sm" onClick={() => editorRef.current?.wrapSelection("**")} />
          <IconButton icon="italic" label={t("composer.italic")} size="sm" onClick={() => editorRef.current?.wrapSelection("_")} />
          <IconButton icon="code" label={t("composer.code")} size="sm" onClick={() => editorRef.current?.codeFormat()} />
          <IconButton icon="list" label={t("composer.list")} size="sm" onClick={() => editorRef.current?.prefixLines("- ")} />
          <span style={{ width: 1, height: 18, background: "var(--border-subtle)", margin: "0 6px" }} />
          <IconButton icon="paperclip" label={t("composer.attach")} size="sm" onClick={() => fileRef.current?.click()} />
          <input
            ref={fileRef}
            type="file"
            style={{ display: "none" }}
            onChange={(e) => void onFilePicked(e.target.files)}
          />
          <IconButton icon="at-sign" label={t("composer.mention")} size="sm" onClick={() => editorRef.current?.insertText("@")} />
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
          <div style={{ flex: 1 }} />
          <IconButton icon="send" label={t("composer.send")} variant="accent" size="lg" disabled={uploading} onClick={clickSend} />
        </div>
      </div>
      <div style={styles.hint}>{t("composer.hint")}</div>
    </div>
  );
}
