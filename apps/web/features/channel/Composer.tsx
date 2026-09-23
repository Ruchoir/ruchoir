"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { FileIcon, Icon, IconButton, type IconName, Popover } from "@/components/ds";
import type { MessageAttachment } from "@/lib/data";
import { deleteFile } from "@/lib/data/api";
import { MenuPopover, type MenuItem } from "../app/MenuPopover";
import type { Toast } from "../app/types";
import { useCompact } from "../app/useCompact";
import { EmojiPicker } from "./EmojiPicker";
import { MessageEditor, type MessageEditorHandle } from "./MessageEditor";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { formatBytes } from "@/lib/i18n/format";

const styles: Record<string, CSSProperties> = {
  wrap: { flex: "none", padding: "8px 24px 20px" },
  composer: {
    maxWidth: "var(--channel-measure)",
    margin: "0 auto",
    borderRadius: "var(--radius-lg)",
    background: "var(--surface-canvas)",
    padding: "10px 12px 8px",
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
  divider: { width: 1, height: 18, background: "var(--border-subtle)", margin: "0 6px" },
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

/**
 * Below this width the toolbar can no longer hold its block tools, and they fold into one menu.
 *
 * Content-driven, and narrower than the shell's own 960px breakpoint on purpose: the row still fits
 * on a tablet, and folding it there would hide nine tools from a screen with room for them.
 */
const TOOLBAR_BREAKPOINT = 640;

/** A block-level formatting tool: an icon, the key of its label, and what it does to the editor. */
type BlockTool = { icon: IconName; label: TranslationKey; apply: (editor: MessageEditorHandle) => void };

/**
 * The block tools, named once and composed twice below.
 *
 * "Titre 1" writes **two** hashes. A single `#` names a channel, in the composer's autocomplete and
 * in the renderer alike, so the largest heading the product reads is `##`. What a writer chooses
 * between is three sizes, which is what the labels say; the markdown underneath is not their problem.
 *
 * Each tool acts on the editor it is handed rather than closing over a ref, which is what lets these
 * live at module scope (and what the React compiler requires: no ref read during render).
 */
const INLINE_CODE: BlockTool = {
  icon: "code",
  label: key("composer.inlineCode"),
  apply: (ed) => ed.codeFormat(),
};
const CODE_BLOCK: BlockTool = {
  icon: "square-code",
  label: key("composer.codeBlock"),
  apply: (ed) => ed.blockCode(),
};
const QUOTE: BlockTool = {
  icon: "quote",
  label: key("composer.quote"),
  apply: (ed) => ed.prefixLines("> "),
};
const HEADINGS: BlockTool[] = [
  { icon: "heading-1", label: key("composer.heading1"), apply: (ed) => ed.prefixLines("## ") },
  { icon: "heading-2", label: key("composer.heading2"), apply: (ed) => ed.prefixLines("### ") },
  { icon: "heading-3", label: key("composer.heading3"), apply: (ed) => ed.prefixLines("#### ") },
];
const LISTS: BlockTool[] = [
  { icon: "list", label: key("composer.list"), apply: (ed) => ed.prefixLines("- ") },
  { icon: "list-ordered", label: key("composer.orderedList"), apply: (ed) => ed.numberLines() },
  { icon: "list-checks", label: key("composer.taskList"), apply: (ed) => ed.prefixLines("- [ ] ") },
];

/**
 * A family of variants on one idea, behind a single button on the wide toolbar.
 *
 * Three heading levels, three kinds of list and two ways to write code were eight buttons of a
 * fourteen-button row, and a row that long is read as a wall rather than as a set of choices. What
 * someone reaches for without thinking (bold, italic, a quotation) stays one click away; picking
 * *which* heading or *which* list is a second thought, and it costs a second click.
 */
type ToolFamily = { icon: IconName; label: TranslationKey; tools: BlockTool[] };

const FAMILIES: ToolFamily[] = [
  { icon: "code", label: key("composer.code"), tools: [INLINE_CODE, CODE_BLOCK] },
  // H with its level marker, not a bare H: next to the B and the I, a lone letter reads as one more
  // character style, and the subscript is what says "and there are several of these".
  { icon: "heading-1", label: key("composer.headings"), tools: HEADINGS },
  { icon: "list", label: key("composer.lists"), tools: LISTS },
];

/**
 * The same tools as one flat menu, for the narrow toolbar, where even the families do not fit.
 *
 * Built from the constants above rather than repeated, so a tool added to a family appears in both
 * places or in neither.
 */
const FORMAT_SECTIONS: { label: TranslationKey | null; tools: BlockTool[] }[] = [
  { label: key("composer.headings"), tools: HEADINGS },
  { label: null, tools: [QUOTE, INLINE_CODE, CODE_BLOCK] },
  { label: key("composer.lists"), tools: LISTS },
];

/**
 * One family's button and its menu.
 *
 * A component of its own because each family needs its own anchor and its own open state, and three
 * of those in the composer would be three pairs of hooks describing the same thing.
 */
function FamilyMenu({ family, run }: { family: ToolFamily; run: (tool: BlockTool) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        ref={ref}
        icon={family.icon}
        label={t(family.label)}
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      <MenuPopover
        anchorRef={ref}
        open={open}
        onClose={() => setOpen(false)}
        items={family.tools.map((tool) => ({ icon: tool.icon, label: t(tool.label), onClick: () => run(tool) }))}
        placement="top"
        align="start"
      />
    </>
  );
}

function iconForType(type: string): string {
  if (type.includes("spreadsheet") || type.includes("csv")) return "file-spreadsheet";
  if (type.startsWith("text")) return "file-text";
  if (type.startsWith("image")) return "image";
  return "file";
}

export type ComposerProps = {
  channelName: string;
  onSend: (text: string, attachments?: MessageAttachment[]) => void;
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
  /** Save the edit with this text and any files newly added to it. */
  onSaveEdit?: (text: string, attachments?: MessageAttachment[]) => void;
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
  const [formatOpen, setFormatOpen] = useState(false);
  const [pending, setPending] = useState<MessageAttachment[]>([]);
  const [editPending, setEditPending] = useState<MessageAttachment[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  /** True while at least one independently started group of files is still being stored. */
  const [uploading, setUploading] = useState(false);
  const activeUploads = useRef(0);
  const editorRef = useRef<MessageEditorHandle>(null);
  const emojiRef = useRef<HTMLButtonElement>(null);
  const formatRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const compact = useCompact(TOOLBAR_BREAKPOINT);

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

  const sendWith = (text: string): boolean => {
    // Pasting can start a second upload while files selected just before it are still moving. The
    // ref is synchronous, so Enter cannot slip through before React paints the disabled button.
    if (activeUploads.current > 0) return false;
    if (editing) {
      onSaveEdit?.(text, editPending.length ? editPending : undefined);
      setEditPending([]);
      return true;
    }
    onSend(text, pending.length ? pending : undefined);
    setPending([]);
    return true;
  };

  const clickSend = () => {
    const ed = editorRef.current;
    if (!ed || activeUploads.current > 0) return;
    const activePending = editing ? editPending : pending;
    if (activePending.length > 0 && ed.isEmpty()) {
      sendWith("");
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

  const cancelEdit = () => {
    editPending.forEach(discardStored);
    setEditPending([]);
    onCancelEdit?.();
  };

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (fileRef.current) fileRef.current.value = "";
    const setActivePending = editing ? setEditPending : setPending;
    activeUploads.current += 1;
    setUploading(true);
    try {
      for (const file of files) {
        const provisional: MessageAttachment = { name: file.name, sizeBytes: file.size, kind: iconForType(file.type) };
        setActivePending((current) => [...current, provisional]);
        try {
          const stored = await onUpload(file);
          setActivePending((current) => current.map((attachment) => (attachment === provisional ? stored : attachment)));
        } catch {
          setActivePending((current) => current.filter((attachment) => attachment !== provisional));
          onNotify({ tone: "danger", title: t("composer.uploadFailed"), description: t("composer.uploadFailedName", { name: file.name }) });
        }
      }
    } finally {
      activeUploads.current -= 1;
      setUploading(activeUploads.current > 0);
    }
  };

  /** Run a tool on the editor. The table holds what each one does; the ref is read here, on click. */
  const runTool = (tool: BlockTool) => {
    const ed = editorRef.current;
    if (ed) tool.apply(ed);
  };

  const formatItems: MenuItem[] = FORMAT_SECTIONS.flatMap((group, i): MenuItem[] => [
    ...(i > 0 ? [{ type: "separator" } as MenuItem] : []),
    ...(group.label ? [{ type: "label", label: t(group.label) } as MenuItem] : []),
    ...group.tools.map((tool): MenuItem => ({ icon: tool.icon, label: t(tool.label), onClick: () => runTool(tool) })),
  ]);

  return (
    <div style={styles.wrap}>
      <div
        className="wc-message-composer"
        style={{
          ...styles.composer,
          ...(editing ? { borderColor: "var(--border-accent)" } : draggingFiles ? { borderColor: "var(--border-accent)", background: "var(--surface-selected)" } : {}),
        }}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes("Files")) setDraggingFiles(true);
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDraggingFiles(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDraggingFiles(false);
          void addFiles(Array.from(event.dataTransfer.files));
        }}
        onInput={signalTyping}
        // Escape leaves an edit, which is the shortcut people reach for first. Caught here rather
        // than on the editor so it works from the toolbar and the emoji picker too.
        onKeyDown={(e) => {
          if (editing && e.key === "Escape") {
            e.stopPropagation();
            cancelEdit();
          }
        }}
      >
        {editing ? (
          <div style={styles.editingBanner}>
            <Icon name="square-pen" size={14} style={{ color: "var(--text-accent)" }} />
            <span style={{ fontWeight: 600, color: "var(--text-accent)" }}>{t("composer.editing")}</span>
            <span style={{ color: "var(--text-subtle)" }}>{t("composer.escToCancel")}</span>
            <div style={{ flex: 1 }} />
            <IconButton icon="x" label={t("composer.cancelEdit")} size="sm" onClick={cancelEdit} />
          </div>
        ) : null}
        {(editing ? editPending : pending).length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {(editing ? editPending : pending).map((attachment, index) => (
              <div key={`${attachment.name}-${index}`} style={styles.chip}>
                <FileIcon name={attachment.name} size={18} />
                <span style={{ fontWeight: 500, color: "var(--text-strong)" }}>{attachment.name}</span>
                <span style={{ color: "var(--text-subtle)" }}>{attachment.fileId ? formatBytes(attachment.sizeBytes) : t("composer.uploading")}</span>
                <IconButton icon="x" label={t("composer.removeAttachment")} size="sm" disabled={!attachment.fileId} onClick={() => {
                  discardStored(attachment);
                  (editing ? setEditPending : setPending)((current) => current.filter((_, currentIndex) => currentIndex !== index));
                }} />
              </div>
            ))}
          </div>
        ) : null}
        <MessageEditor
          ref={editorRef}
          placeholder={editing ? t("message.editMessage") : t("composer.writeIn", { name: channelName })}
          onSend={sendWith}
          onPasteFiles={(files) => void addFiles(files)}
        />
        <div style={styles.tools}>
          <IconButton icon="bold" label={t("composer.bold")} size="sm" onClick={() => editorRef.current?.wrapSelection("**")} />
          <IconButton icon="italic" label={t("composer.italic")} size="sm" onClick={() => editorRef.current?.wrapSelection("_")} />
          {compact ? (
            <IconButton icon="code" label={t("composer.inlineCode")} size="sm" onClick={() => runTool(INLINE_CODE)} />
          ) : null}
          {compact ? (
            <>
              <span style={styles.divider} />
              <IconButton
                ref={formatRef}
                icon="type"
                label={t("composer.format")}
                size="sm"
                aria-expanded={formatOpen}
                aria-haspopup="menu"
                onClick={() => setFormatOpen((o) => !o)}
              />
              <MenuPopover
                anchorRef={formatRef}
                open={formatOpen}
                onClose={() => setFormatOpen(false)}
                items={formatItems}
                placement="top"
                align="start"
              />
            </>
          ) : (
            <>
              {/* Code sits with bold and italic: it is the third thing one marks inside a sentence,
                  and its menu is what separates a word from a whole block. */}
              <FamilyMenu family={FAMILIES[0]} run={runTool} />
              <span style={styles.divider} />
              <FamilyMenu family={FAMILIES[1]} run={runTool} />
              <IconButton icon={QUOTE.icon} label={t(QUOTE.label)} size="sm" onClick={() => runTool(QUOTE)} />
              <FamilyMenu family={FAMILIES[2]} run={runTool} />
            </>
          )}
          <span style={styles.divider} />
          <IconButton icon="paperclip" label={t("composer.attach")} size="sm" onClick={() => fileRef.current?.click()} />
          <input
            ref={fileRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => void addFiles(Array.from(e.target.files ?? []))}
          />
          <IconButton icon="at-sign" label={t("composer.mention")} size="sm" onClick={() => editorRef.current?.insertTrigger("@")} />
          {/* Beside the `@` because it is the same gesture on a different subject: the editor's own
              autocomplete answers both, and a handle nobody can guess is a handle nobody uses. */}
          <IconButton icon="hash" label={t("composer.room")} size="sm" onClick={() => editorRef.current?.insertTrigger("#")} />
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
