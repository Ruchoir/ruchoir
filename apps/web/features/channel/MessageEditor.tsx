"use client";

import { type ClipboardEvent, type CSSProperties, type KeyboardEvent, type Ref, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Avatar, Icon, Popover } from "@/components/ds";
import {
  getChannelMembers,
  getNoRooms,
  getServerDirectory,
  getSpaceRooms,
  subscribeToDirectory,
} from "@/lib/data";
import { searchShortcodes } from "@/lib/shortcodes";
import { Emoji } from "../app/Emoji";
import { useEmojiManifest } from "../app/emojiManifest";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import {
  editorState,
  emojiNode,
  insertBlockAtSelection,
  insertLineBreakAtSelection,
  insertNodeAtSelection,
  insertTextAtSelection,
  replaceTokenBeforeCaret,
  serialize,
} from "./composerEditor";

type Member = ReturnType<typeof getChannelMembers>[number];

/** A ranked autocomplete suggestion, tagged by the trigger that produced it. */
type Hit =
  | { kind: "mention"; name: string; member: Member }
  | { kind: "broadcast"; name: string; hint: TranslationKey }
  | { kind: "emoji"; name: string; emoji: string }
  | { kind: "room"; name: string };

/**
 * The two handles that address a room rather than a person.
 *
 * Offered here because a handle nobody can guess is a handle nobody uses: everything else in this
 * list is a name the reader can see on screen, while these two have to be learned. The hint is what
 * makes them different from each other, and it is the behaviour, not a paraphrase of the word: one
 * reaches the whole channel, the other only the people connected right now.
 */
/** The two broadcast mentions, with the dictionary key of their hint. */
const BROADCASTS: { name: string; hint: TranslationKey }[] = [
  { name: "canal", hint: key("composer.broadcastChannel") },
  { name: "ici", hint: key("composer.broadcastHere") },
];

type Trigger = { kind: "mention" | "emoji" | "room"; query: string; start: number };

/** Imperative surface so a surrounding toolbar can act on the editor without owning its DOM. */
export type MessageEditorHandle = {
  focus: () => void;
  /** Serialise, send if non-empty, then clear. Used by the send button. */
  submit: () => void;
  insertEmoji: (glyph: string) => void;
  insertText: (text: string) => void;
  /**
   * Type a trigger character (`@` or `#`) and open its suggestion list.
   *
   * Not `insertText`: the triggers only fire at the start of a token, so the same character typed
   * against the end of a word is a literal one. The toolbar buttons went through `insertText` and
   * were silent whenever the caret sat after a letter, which is most of the time.
   */
  insertTrigger: (char: "@" | "#") => void;
  wrapSelection: (before: string, after?: string) => void;
  /** Prefix the selected lines, or open a fresh line carrying `prefix`. */
  prefixLines: (prefix: string) => void;
  /** Number the selected lines "1. ", "2. ", and so on. */
  numberLines: () => void;
  codeFormat: () => void;
  /** Open a fenced code block around the selection, caret inside it when there is none. */
  blockCode: () => void;
  /** Whether the editor currently has no text (used to allow attachment-only sends). */
  isEmpty: () => boolean;
  /** Clear the editor without sending. */
  clear: () => void;
  /**
   * Replace everything in the editor with this text, caret at the end.
   *
   * For picking up a message to edit: the body has to arrive in the composer as if it had just been
   * typed there, ready to be continued.
   */
  setText: (text: string) => void;
};

const menuStyle: CSSProperties = {
  minWidth: 240,
  maxWidth: 320,
  padding: 4,
  background: "var(--surface-canvas)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-popover)",
};

/** Stands in for the avatar on the two room-wide handles, so the rows line up. */
const broadcastMark: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "none",
  width: 22,
  height: 22,
  borderRadius: "var(--radius-sm)",
  background: "var(--surface-selected)",
  color: "var(--text-accent)",
  fontWeight: 600,
  fontSize: 12,
};

const optionStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 8px",
  border: 0,
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--text-body)",
};

export type MessageEditorProps = {
  placeholder: string;
  onSend: (text: string) => void;
  ariaLabel?: string;
  ref?: Ref<MessageEditorHandle>;
};

/**
 * Contenteditable message input: renders inline Fluent emote chips (which a plain textarea cannot),
 * with a keyboard-navigable `@mention` / `:shortcode` autocomplete. It is uncontrolled (the browser
 * owns the DOM); `onSend` receives the serialised plain text (emotes as their Unicode glyph), so the
 * message pipeline is unchanged. The surrounding toolbar drives formatting through the ref handle.
 */
export function MessageEditor({ placeholder, onSend, ariaLabel, ref }: MessageEditorProps) {
  const { t } = useTranslation();
  const edRef = useRef<HTMLDivElement>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [active, setActive] = useState(0);
  const [empty, setEmpty] = useState(true);

  const manifest = useEmojiManifest();
  // Keep a ref to the latest manifest so event handlers read the current value without re-subscribing.
  // Assigned in an effect (not during render) per the React "latest ref" guidance.
  const manifestRef = useRef(manifest);
  useEffect(() => {
    manifestRef.current = manifest;
  });

  const uid = useId();
  const listId = `ac-${uid}`;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  // Subscribed, not captured. With an empty dependency list this froze at whatever roster existed
  // when the composer first mounted, so after a space switch it went on offering the previous
  // space's people, with no way to notice from here.
  const members = useSyncExternalStore(subscribeToDirectory, getChannelMembers, getServerDirectory);
  // The channels of this space, published beside the roster: `#` names a room the way `@` names a
  // person, and offering a room from the space being left would be the same leak.
  const rooms = useSyncExternalStore(subscribeToDirectory, getSpaceRooms, getNoRooms);

  const hits = useMemo<Hit[]>(() => {
    if (!trigger) return [];
    if (trigger.kind === "mention") {
      const q = trigger.query.toLowerCase();
      // Above the people, because they are the two entries someone is looking for when they do not
      // have a particular person in mind, and because there are only ever two of them.
      const broadcasts = BROADCASTS.filter((b) => b.name.startsWith(q)).map(
        (b): Hit => ({ kind: "broadcast", name: b.name, hint: b.hint }),
      );
      const people = members
        .filter((m) => m.name.toLowerCase().includes(q))
        .slice(0, 6)
        .map((m): Hit => ({ kind: "mention", name: m.name, member: m }));
      return [...broadcasts, ...people];
    }
    if (trigger.kind === "room") {
      const q = trigger.query.toLowerCase();
      return rooms
        .filter((name) => name.toLowerCase().includes(q))
        .slice(0, 6)
        .map((name): Hit => ({ kind: "room", name }));
    }
    return searchShortcodes(trigger.query).map((r): Hit => ({ kind: "emoji", name: r.name, emoji: r.emoji }));
  }, [trigger, members, rooms]);

  const acOpen = trigger != null && hits.length > 0;
  const activeIdx = Math.min(active, Math.max(0, hits.length - 1));

  /** Anchor autocomplete to the insertion point instead of the editor's leading edge. */
  const getCaretRect = useCallback(() => {
    const ed = edRef.current;
    const selection = window.getSelection();
    if (!ed || !selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!range.collapsed || !ed.contains(range.startContainer)) return null;

    const rect = range.getBoundingClientRect();
    // A collapsed range has no width, but its height and position describe the current text line.
    // Some engines return an entirely empty rectangle at unsupported boundary positions; falling
    // back to the editor there is safer than flashing the menu at the viewport origin.
    return rect.height || rect.top || rect.left ? rect : null;
  }, []);

  /** Fire `@partial` or `:partial` detection from the text before the caret. */
  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const mention = /(?:^|\s)@([\p{L}\p{N}_'-]*)$/u.exec(before);
    if (mention) {
      setTrigger({ kind: "mention", query: mention[1], start: caret - mention[1].length - 1 });
      setActive(0);
      return;
    }
    // One hash only: `##` and beyond are a heading, and suggesting rooms under a title would put a
    // menu in front of somebody writing one.
    const room = /(?:^|\s)#([\p{L}\p{N}_-]*)$/u.exec(before);
    if (room && !before.endsWith("##")) {
      setTrigger({ kind: "room", query: room[1], start: caret - room[1].length - 1 });
      setActive(0);
      return;
    }
    const shortcode = /(?:^|\s):([a-z0-9_+-]+)$/i.exec(before);
    if (shortcode) {
      setTrigger({ kind: "emoji", query: shortcode[1], start: caret - shortcode[1].length - 1 });
      setActive(0);
      return;
    }
    setTrigger(null);
  };

  /** Read the editor, refresh the placeholder flag, and re-run autocomplete detection. */
  const sync = () => {
    const ed = edRef.current;
    if (!ed) return;
    const { text, caret } = editorState(ed);
    setEmpty(text.trim() === "");
    detect(text, caret);
  };

  /** Put the caret inside the editor (at the end) when it is not already there. */
  const ensureCaret = () => {
    const ed = edRef.current;
    if (!ed) return;
    ed.focus();
    const sel = window.getSelection();
    if (!sel) return;
    if (!sel.focusNode || !ed.contains(sel.focusNode)) {
      const range = document.createRange();
      range.selectNodeContents(ed);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };

  const submit = () => {
    const ed = edRef.current;
    if (!ed) return;
    const text = serialize(ed).replace(/\s+$/, "");
    if (text.trim()) onSend(text);
    ed.innerHTML = "";
    setTrigger(null);
    setEmpty(true);
    ed.focus();
  };

  const pick = (hit: Hit) => {
    const ed = edRef.current;
    if (!ed || !trigger) return;
    const { caret } = editorState(ed);
    const len = caret - trigger.start;
    if (hit.kind === "room") {
      replaceTokenBeforeCaret(len, document.createTextNode(`#${hit.name} `));
    } else if (hit.kind === "mention" || hit.kind === "broadcast") {
      // The display name, whole. The server resolves it as written, so what is typed, what is shown
      // and who is notified are the same thing.
      replaceTokenBeforeCaret(len, document.createTextNode(`@${hit.name} `));
    } else {
      replaceTokenBeforeCaret(len, emojiNode(hit.emoji, manifestRef.current), true);
    }
    setTrigger(null);
    ed.focus();
    sync();
  };

  const insertEmoji = (glyph: string) => {
    ensureCaret();
    insertNodeAtSelection(emojiNode(glyph, manifestRef.current), true);
    sync();
  };

  const insertText = (text: string) => {
    ensureCaret();
    insertTextAtSelection(text);
    sync();
  };

  const wrapSelection = (before: string, after = before) => {
    ensureCaret();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const selected = sel.toString();
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(before + selected + after);
    range.insertNode(node);
    const pos = selected ? before.length + selected.length : before.length;
    const caret = document.createRange();
    caret.setStart(node, Math.min(pos, node.textContent?.length ?? pos));
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
    sync();
  };

  /**
   * What the editor looks like where the caret is: whether a line is already open there, and the
   * break to type first when it is not.
   *
   * Every block tool needs this. A quotation, a heading or a list item is only read as one when its
   * marker opens the line, so pressing "Citation" halfway through a sentence has to start a line
   * rather than drop "> " between two words, which is what it used to do.
   */
  const lineBreakBefore = (): string => {
    const ed = edRef.current;
    if (!ed) return "";
    const { text, caret } = editorState(ed);
    return caret === 0 || text[caret - 1] === "\n" ? "" : "\n";
  };

  /** Give every selected line the prefix `prefixFor` returns for its index, or open one line with it. */
  const applyLinePrefix = (prefixFor: (index: number) => string) => {
    ensureCaret();
    const selected = window.getSelection()?.toString() ?? "";
    if (selected) {
      insertTextAtSelection(selected.split("\n").map((line, i) => prefixFor(i) + line).join("\n"));
    } else {
      insertTextAtSelection(lineBreakBefore() + prefixFor(0));
    }
    sync();
  };

  const prefixLines = (prefix: string) => applyLinePrefix(() => prefix);

  /**
   * Number the selected lines, or open the next item of the list already being written.
   *
   * The numbers are written out rather than left to the renderer, because the message travels as
   * text: someone reading it in a mail notification, or in a client that renders nothing, still
   * gets a list that counts. Which is also why the button continues from the line above instead of
   * starting at 1 every time: pressing it four times used to write "1." four times.
   */
  const numberLines = () => {
    ensureCaret();
    const ed = edRef.current;
    let first = 1;
    if (ed && !window.getSelection()?.toString()) {
      const { text, caret } = editorState(ed);
      const lines = text.slice(0, caret).split("\n");
      // The line the caret is on, or the one above it when that line is empty (the tool would open
      // a line of its own there anyway).
      const previous = lines[lines.length - 1] || lines[lines.length - 2] || "";
      const numbered = /^(\d{1,9})[.)] /.exec(previous);
      if (numbered) first = Number(numbered[1]) + 1;
    }
    applyLinePrefix((i) => `${first + i}. `);
  };

  const codeFormat = () => {
    ensureCaret();
    const selected = window.getSelection()?.toString() ?? "";
    if (selected.includes("\n")) {
      insertTextAtSelection(`\`\`\`\n${selected}\n\`\`\``);
      sync();
    } else {
      wrapSelection("`");
    }
  };

  const blockCode = () => {
    ensureCaret();
    const selected = window.getSelection()?.toString() ?? "";
    // With nothing selected the fences are empty, so the caret goes on the line between them
    // (four characters from the end: the newline and the three closing backticks).
    insertBlockAtSelection(`${lineBreakBefore()}\`\`\`\n${selected}\n\`\`\``, selected ? 0 : 4);
    sync();
  };

  const insertTrigger = (char: "@" | "#") => {
    ensureCaret();
    const ed = edRef.current;
    if (!ed) return;
    const { text, caret } = editorState(ed);
    // The trigger is only a trigger at the start of a token, so it takes a space with it when the
    // caret is against a word. One space, never two: the character before is checked, not assumed.
    const lead = caret === 0 || /\s/.test(text[caret - 1]) ? "" : " ";
    insertTextAtSelection(lead + char);
    sync();
  };

  useImperativeHandle(ref, () => ({
    focus: () => edRef.current?.focus(),
    submit,
    insertEmoji,
    insertText,
    insertTrigger,
    wrapSelection,
    prefixLines,
    numberLines,
    codeFormat,
    blockCode,
    isEmpty: () => {
      const ed = edRef.current;
      return !ed || serialize(ed).trim() === "";
    },
    clear: () => {
      const ed = edRef.current;
      if (!ed) return;
      ed.innerHTML = "";
      setTrigger(null);
      setEmpty(true);
    },
    setText: (text: string) => {
      const ed = edRef.current;
      if (!ed) return;
      // Written as a text node rather than as HTML: the body is the user's own text, and anything
      // in it that looks like markup is text too.
      ed.innerHTML = "";
      ed.append(document.createTextNode(text));
      setTrigger(null);
      setEmpty(text === "");
      ed.focus();
      // Caret after the last character, which is where someone picking up their own sentence
      // expects to continue from.
      const range = document.createRange();
      range.selectNodeContents(ed);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
  }));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (acOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % hits.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + hits.length) % hits.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(hits[activeIdx] ?? hits[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setTrigger(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      const ed = edRef.current;
      if (ed) insertLineBreakAtSelection(ed);
      sync();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    insertTextAtSelection(e.clipboardData.getData("text/plain"));
    sync();
  };

  return (
    <>
      <div
        ref={edRef}
        className="wc-rich-input"
        contentEditable
        suppressContentEditableWarning
        role="combobox"
        aria-expanded={acOpen}
        aria-autocomplete="list"
        aria-controls={acOpen ? listId : undefined}
        aria-activedescendant={acOpen ? optionId(activeIdx) : undefined}
        aria-label={ariaLabel ?? placeholder}
        data-placeholder={placeholder}
        data-empty={empty}
        onInput={sync}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <Popover anchorRef={edRef} getAnchorRect={getCaretRect} open={acOpen} onClose={() => setTrigger(null)} placement="top" align="start">
        <div id={listId} style={menuStyle} role="listbox" aria-label={trigger?.kind === "emoji" ? t("prefs.emojis") : t("conversation.members")}>
          {hits.map((hit, idx) => (
            <button
              key={`${hit.kind}-${hit.name}`}
              id={optionId(idx)}
              type="button"
              role="option"
              aria-selected={idx === activeIdx}
              onMouseDown={(e) => e.preventDefault()} // keep the editor focused
              onMouseEnter={() => setActive(idx)}
              onClick={() => pick(hit)}
              style={{ ...optionStyle, background: idx === activeIdx ? "var(--surface-hover)" : "transparent" }}
            >
              {hit.kind === "broadcast" ? (
                <>
                  <span style={broadcastMark} aria-hidden="true">
                    @
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block" }}>{hit.name}</span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-subtle)" }}>{t(hit.hint)}</span>
                  </span>
                </>
              ) : hit.kind === "mention" ? (
                <>
                  <Avatar
                    name={hit.member.name}
                    src={hit.member.avatar}
                    size={22}
                    presence={hit.member.presence}
                    kind={hit.member.bot ? "bot" : "person"}
                    shape={hit.member.bot ? "round" : "square"}
                  />
                  {hit.name}
                </>
              ) : hit.kind === "room" ? (
                <>
                  <Icon name="hash" size={16} style={{ color: "var(--text-muted)" }} />
                  {hit.name}
                </>
              ) : (
                <>
                  <Emoji emoji={hit.emoji} size={18} />
                  <span style={{ color: "var(--text-muted)" }}>:{hit.name}:</span>
                </>
              )}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
