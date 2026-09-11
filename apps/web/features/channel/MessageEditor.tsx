"use client";

import { type ClipboardEvent, type CSSProperties, type KeyboardEvent, type Ref, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Avatar, Popover } from "@/components/ds";
import { getChannelMembers, getServerDirectory, subscribeToDirectory } from "@/lib/data";
import { searchShortcodes } from "@/lib/shortcodes";
import { Emoji } from "../app/Emoji";
import { useEmojiManifest } from "../app/emojiManifest";
import {
  editorState,
  emojiNode,
  insertNodeAtSelection,
  insertTextAtSelection,
  replaceTokenBeforeCaret,
  serialize,
} from "./composerEditor";

type Member = ReturnType<typeof getChannelMembers>[number];

/** A ranked autocomplete suggestion, tagged by the trigger that produced it. */
type Hit =
  | { kind: "mention"; name: string; member: Member }
  | { kind: "broadcast"; name: string; hint: string }
  | { kind: "emoji"; name: string; emoji: string };

/**
 * The two handles that address a room rather than a person.
 *
 * Offered here because a handle nobody can guess is a handle nobody uses: everything else in this
 * list is a name the reader can see on screen, while these two have to be learned. The hint is what
 * makes them different from each other, and it is the behaviour, not a paraphrase of the word: one
 * reaches the whole channel, the other only the people connected right now.
 */
const BROADCASTS: { name: string; hint: string }[] = [
  { name: "canal", hint: "Prévient tous les membres du canal" },
  { name: "ici", hint: "Prévient seulement les membres connectés" },
];

type Trigger = { kind: "mention" | "emoji"; query: string; start: number };

/** Imperative surface so a surrounding toolbar can act on the editor without owning its DOM. */
export type MessageEditorHandle = {
  focus: () => void;
  /** Serialise, send if non-empty, then clear. Used by the send button. */
  submit: () => void;
  insertEmoji: (glyph: string) => void;
  insertText: (text: string) => void;
  wrapSelection: (before: string, after?: string) => void;
  prefixLines: (prefix: string) => void;
  codeFormat: () => void;
  /** Whether the editor currently has no text (used to allow attachment-only sends). */
  isEmpty: () => boolean;
  /** Clear the editor without sending. */
  clear: () => void;
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
    return searchShortcodes(trigger.query).map((r): Hit => ({ kind: "emoji", name: r.name, emoji: r.emoji }));
  }, [trigger, members]);

  const acOpen = trigger != null && hits.length > 0;
  const activeIdx = Math.min(active, Math.max(0, hits.length - 1));

  /** Fire `@partial` or `:partial` detection from the text before the caret. */
  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const mention = /(?:^|\s)@([\p{L}\p{N}_'-]*)$/u.exec(before);
    if (mention) {
      setTrigger({ kind: "mention", query: mention[1], start: caret - mention[1].length - 1 });
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
    if (hit.kind === "mention" || hit.kind === "broadcast") {
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

  const prefixLines = (prefix: string) => {
    ensureCaret();
    const selected = window.getSelection()?.toString() ?? "";
    const replaced = (selected || "").split("\n").map((l) => prefix + l).join("\n");
    insertTextAtSelection(replaced || prefix);
    sync();
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

  useImperativeHandle(ref, () => ({
    focus: () => edRef.current?.focus(),
    submit,
    insertEmoji,
    insertText,
    wrapSelection,
    prefixLines,
    codeFormat,
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
      insertTextAtSelection("\n");
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
      <Popover anchorRef={edRef} open={acOpen} onClose={() => setTrigger(null)} placement="top" align="start">
        <div id={listId} style={menuStyle} role="listbox" aria-label={trigger?.kind === "emoji" ? "Emojis" : "Membres"}>
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
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-subtle)" }}>{hit.hint}</span>
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
