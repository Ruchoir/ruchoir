import emojiRegex from "emoji-regex";
import type { ReactNode } from "react";
import { Checkbox, Tooltip } from "@/components/ds";
import { Emoji } from "../app/Emoji";
import { replaceShortcodes, shortcodeOf } from "@/lib/shortcodes";
import { CodeBlock } from "./CodeBlock";

/** Anchored emoji matcher (to test at a given position). */
const EMOJI_RE = new RegExp(`^(?:${emojiRegex().source})`);

const EMOJI_SIZE = 19;

/**
 * When a message is nothing but emoji (and whitespace), render them larger (Slack/Discord "jumbo").
 * Returns the emoji count for such a message, or 0 when any other character is present.
 */

/**
 * Leave out the sentence punctuation that follows a link ("voir https://example.org."), keeping a
 * closing bracket the link opened itself (`https://fr.wikipedia.org/wiki/Rust_(langage)`). The
 * server applies the same rule when it picks the link to preview (`messaging/unfurl.rs`).
 */
function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    const head = url.slice(0, end);
    const count = (c: string) => head.split(c).length - 1;
    const drop =
      ".,;:!?\"'>*_".includes(last) ||
      (last === ")" && count("(") < count(")")) ||
      (last === "]" && count("[") < count("]"));
    if (!drop) break;
    end -= 1;
  }
  return url.slice(0, end);
}

function jumboEmojiCount(text: string): number {
  let i = 0;
  let count = 0;
  while (i < text.length) {
    const em = EMOJI_RE.exec(text.slice(i));
    if (em) {
      count += 1;
      i += em[0].length;
      continue;
    }
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    return 0;
  }
  return count;
}

/** Emoji size for a message: bigger when the whole message is emoji-only, tapering with count. */
function emojiSizeFor(count: number): number {
  if (count === 0) return EMOJI_SIZE;
  if (count === 1) return 44;
  if (count <= 3) return 36;
  return 28;
}

/**
 * Rich-text renderer for message bodies: **bold**, _italic_, ~~struck through~~, `code`, fenced
 * ``` code blocks (highlighted by CodeBlock), http(s) links, "- " and "1." lists, "- [ ] " and
 * "- [x] " checklists, "> " quotes, "## " headings (two hashes and up: one is a channel), and
 * @mentions. Inline formatting builds React nodes; code highlighting happens in CodeBlock.
 *
 * It deliberately **reads more than the composer writes**. A message brought over from another
 * product was written in that product's Markdown, and a quotation that arrives as a line beginning
 * with a greater-than sign is a migration that visibly lost something. Reading a wider vocabulary
 * than we offer costs nothing and is what every Markdown reader does.
 */

function matchMention(text: string, from: number, names: string[]): string | null {
  const rest = text.slice(from);
  let best: string | null = null;
  for (const n of names) {
    if (rest.startsWith(n) && (!best || n.length > best.length)) best = n;
  }
  return best;
}

/** The rooms a `#name` can point at, and what to do when a reader follows one. */
export type Rooms = { names: string[]; onOpen?: (name: string) => void };

/**
 * Tick or untick the checklist item written on line `line` of the body (0-based, counted over the
 * whole message, fenced code included so the number survives a block in the middle).
 *
 * Passed only where the reader may change the message: the API accepts an edit from its author and
 * from nobody else, so everywhere else the boxes are drawn read-only rather than failing on click.
 */
export type TaskToggle = (line: number, done: boolean) => void;

function renderInline(
  text: string,
  names: string[],
  keyBase: string,
  emojiSize = EMOJI_SIZE,
  onMention?: MentionHandler,
  meName?: string,
  rooms?: Rooms,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buf = "";
  let i = 0;
  let k = 0;
  const flush = () => {
    if (buf) {
      nodes.push(buf);
      buf = "";
    }
  };
  while (i < text.length) {
    const em = EMOJI_RE.exec(text.slice(i));
    if (em) {
      flush();
      const key = `${keyBase}-e${k++}`;
      const glyph = em[0];
      const shortcode = shortcodeOf(glyph);
      const node = <Emoji emoji={glyph} size={emojiSize} />;
      nodes.push(
        shortcode ? (
          <Tooltip key={key} label={shortcode}>
            {node}
          </Tooltip>
        ) : (
          <span key={key} style={{ display: "inline-flex" }}>
            {node}
          </span>
        ),
      );
      i += glyph.length;
      continue;
    }
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 1) {
        flush();
        nodes.push(<strong key={`${keyBase}-b${k++}`}>{renderInline(text.slice(i + 2, end), names, `${keyBase}-b${k}`, emojiSize, onMention, meName, rooms)}</strong>);
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith("~~", i)) {
      const end = text.indexOf("~~", i + 2);
      if (end > i + 1) {
        flush();
        nodes.push(<s key={`${keyBase}-s${k++}`}>{renderInline(text.slice(i + 2, end), names, `${keyBase}-s${k}`, emojiSize, onMention, meName, rooms)}</s>);
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        nodes.push(<code key={`${keyBase}-c${k++}`} className="wc-code">{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "_") {
      const end = text.indexOf("_", i + 1);
      if (end > i) {
        flush();
        nodes.push(<em key={`${keyBase}-i${k++}`}>{text.slice(i + 1, end)}</em>);
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "@") {
      const name = matchMention(text, i + 1, names);
      if (name) {
        flush();
        const mkey = `${keyBase}-m${k++}`;
        const isMe = !!meName && (name === meName || name === meName.split(" ")[0]);
        const cls = isMe ? "wc-mention wc-mention--me" : "wc-mention";
        nodes.push(
          onMention ? (
            <button
              key={mkey}
              type="button"
              className={cls}
              onClick={(e) => onMention(name, e.currentTarget)}
              style={{ border: 0, padding: "0 3px", font: "inherit", cursor: "pointer" }}
            >
              @{name}
            </button>
          ) : (
            <span key={mkey} className={cls}>
              @{name}
            </span>
          ),
        );
        i = i + 1 + name.length;
        continue;
      }
    }
    // A room, pointed at the way a person is: `#produit` is the handle everyone reads on screen,
    // and a reader following it should land in the room rather than copy the word into a search.
    if (text[i] === "#" && rooms) {
      const room = matchMention(text, i + 1, rooms.names);
      if (room) {
        flush();
        const rkey = `${keyBase}-r${k++}`;
        nodes.push(
          rooms.onOpen ? (
            <button
              key={rkey}
              type="button"
              className="wc-mention wc-mention--room"
              onClick={() => rooms.onOpen?.(room)}
              style={{ border: 0, padding: "0 3px", font: "inherit", cursor: "pointer" }}
            >
              #{room}
            </button>
          ) : (
            <span key={rkey} className="wc-mention wc-mention--room">
              #{room}
            </span>
          ),
        );
        i = i + 1 + room.length;
        continue;
      }
    }
    if (text.startsWith("http", i)) {
      const m = /^https?:\/\/[^\s]+/.exec(text.slice(i));
      const url = m ? trimTrailing(m[0]) : "";
      if (url.length > "https://".length) {
        flush();
        // A real link, in a new tab, with no referrer and no handle on this window. It used to be
        // drawn with its click cancelled, a leftover of the mock-up, so a link did nothing at all.
        nodes.push(
          <a
            key={`${keyBase}-l${k++}`}
            className="wc-message-link"
            href={url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            onClick={(e) => e.stopPropagation()}
          >
            {url}
          </a>,
        );
        i += url.length;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  flush();
  return nodes;
}

/** Render a plain-text block (no fenced code): lists, line breaks, and inline formatting. */
function renderTextBlock(
  text: string,
  names: string[],
  keyBase: string,
  emojiSize = EMOJI_SIZE,
  onMention?: MentionHandler,
  meName?: string,
  rooms?: Rooms,
  onToggleTask?: TaskToggle,
  /** Line number this block starts on within the whole body, so a tick can name its line. */
  lineBase = 0,
): ReactNode[] {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  /** The run of lines being gathered: bullets, numbered items, checklist items, or quoted lines. */
  let run: ReactNode[] | null = null;
  let runKind: "ul" | "ol" | "task" | "quote" | null = null;
  let bi = 0;

  // Consecutive lines of the same kind are one block: three quoted lines are one quotation with
  // one bar down its side, not three.
  const closeRun = () => {
    if (!run) return;
    const items = run;
    const key = `${keyBase}-${runKind}${bi++}`;
    if (runKind === "quote") {
      blocks.push(
        <blockquote key={key} className="wc-quote">
          {items}
        </blockquote>,
      );
    } else if (runKind === "task") {
      // No marker and no indent: the boxes are the marker, and they line up with the text above.
      blocks.push(
        <ul key={key} className="wc-tasks">
          {items}
        </ul>,
      );
    } else if (runKind === "ol") {
      blocks.push(
        // The marker is set here because the CSS reset takes it off every list in the product:
        // without it an imported (or typed) list arrives as lines that start with a space, which
        // is how "1." and "2." disappeared from a migrated message.
        <ol key={key} style={{ margin: "2px 0", paddingLeft: 22, listStyleType: "decimal" }}>
          {items}
        </ol>,
      );
    } else {
      blocks.push(
        <ul key={key} style={{ margin: "2px 0", paddingLeft: 20, listStyleType: "disc" }}>
          {items}
        </ul>,
      );
    }
    run = null;
    runKind = null;
  };

  const openRun = (kind: "ul" | "ol" | "task" | "quote") => {
    if (runKind !== kind) closeRun();
    runKind = kind;
    run ??= [];
    return run;
  };

  lines.forEach((line, idx) => {
    const inline = (from: string) =>
      renderInline(from, names, `${keyBase}ln${idx}`, emojiSize, onMention, meName, rooms);
    const numbered = /^(\d{1,9})[.)] /.exec(line);
    // A checklist item, before the bullet test that would otherwise swallow it and leave "[ ]" as
    // the first two characters of the text.
    const task = /^[-*] \[([ xX])\] ?(.*)$/.exec(line);
    // Two hashes and up are a heading; one is not. A single `#` opens a channel, here and in the
    // composer, and a line beginning "#produit" is a reader pointing at a room, not a title.
    const heading = /^(#{2,6}) +(\S.*)$/.exec(line);
    if (heading) {
      closeRun();
      const level = Math.min(heading[1].length, 6);
      const size = [0, 0, 19, 17, 15, 14, 14][level];
      blocks.push(
        <div
          key={`${keyBase}-h${idx}`}
          role="heading"
          aria-level={level}
          style={{
            margin: idx === 0 ? "0 0 2px" : "8px 0 2px",
            fontSize: size,
            fontWeight: 600,
            lineHeight: 1.3,
            color: "var(--text-strong)",
          }}
        >
          {inline(heading[2])}
        </div>,
      );
    } else if (task) {
      const done = task[1] !== " ";
      const at = lineBase + idx;
      // The design system's checkbox, not a bare input: the product already decided what a box
      // looks like ticked, focused and read-only, and the browser's own is neither themed nor the
      // same shape twice. Its label carries the item's text, so the sentence is part of the target.
      openRun("task").push(
        <li key={`${keyBase}-tk${idx}`}>
          <Checkbox
            checked={done}
            // Read-only on a message that is not the reader's: the API takes an edit from the
            // author alone, so an inviting box here would only ever answer with a refusal.
            disabled={!onToggleTask}
            onChange={() => onToggleTask?.(at, !done)}
            label={<span className={done ? "wc-task-done" : undefined}>{inline(task[2])}</span>}
          />
        </li>,
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      openRun("ul").push(<li key={`${keyBase}-li${idx}`}>{inline(line.slice(2))}</li>);
    } else if (numbered) {
      openRun("ol").push(<li key={`${keyBase}-oi${idx}`}>{inline(line.slice(numbered[0].length))}</li>);
    } else if (line === ">" || line.startsWith("> ")) {
      openRun("quote").push(
        <span key={`${keyBase}-q${idx}`}>
          {inline(line.slice(2))}
          {"\n"}
        </span>,
      );
    } else {
      closeRun();
      blocks.push(
        <span key={`${keyBase}-ln${idx}`}>
          {inline(line)}
          {idx < lines.length - 1 ? "\n" : null}
        </span>,
      );
    }
  });
  closeRun();
  return blocks;
}

/**
 * What a click on an `@mention` receives: the name, and the element that was clicked, which is what
 * a profile card is anchored to.
 */
export type MentionHandler = (name: string, anchor: HTMLElement) => void;

export function renderRichText(
  text: string,
  names: string[],
  editable = false,
  onMention?: MentionHandler,
  meName?: string,
  rooms?: Rooms,
  onToggleTask?: TaskToggle,
): ReactNode {
  // Split on ``` fences: odd segments are fenced code blocks.
  const segments = text.split("```");
  // Lines are counted over the whole body, across the fences, because a tick names the line it
  // wants changed and the caller looks it up in the text as it was sent. The delimiters carry no
  // newline of their own, so summing each segment's is enough.
  let lineBase = 0;
  // Emoji-only messages (no fenced code) render larger; the size tapers with the emoji count.
  const emojiSize = segments.length > 1 ? EMOJI_SIZE : emojiSizeFor(jumboEmojiCount(replaceShortcodes(text)));
  const out: ReactNode[] = [];
  segments.forEach((seg, i) => {
    if (i % 2 === 1) {
      let code = seg;
      let lang: string | undefined;
      const nl = code.indexOf("\n");
      if (nl > -1) {
        const first = code.slice(0, nl).trim();
        if (/^[a-z0-9+#.-]{1,12}$/i.test(first)) {
          lang = first.toLowerCase();
          code = code.slice(nl + 1);
        }
      }
      code = code.replace(/\n$/, "");
      out.push(<CodeBlock key={`pre${i}`} code={code} declaredLang={lang} editable={editable} />);
    } else if (seg) {
      out.push(
        ...renderTextBlock(
          replaceShortcodes(seg),
          names,
          `s${i}`,
          emojiSize,
          onMention,
          meName,
          rooms,
          onToggleTask,
          lineBase,
        ),
      );
    }
    lineBase += seg.split("\n").length - 1;
  });
  return out;
}
