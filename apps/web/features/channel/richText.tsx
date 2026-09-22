import emojiRegex from "emoji-regex";
import type { ReactNode } from "react";
import { Tooltip } from "@/components/ds";
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
 * ``` code blocks (highlighted by CodeBlock), http(s) links, "- " and "1." lists, "> " quotes,
 * "## " headings (two hashes and up: one is a channel), and
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

function renderInline(
  text: string,
  names: string[],
  keyBase: string,
  emojiSize = EMOJI_SIZE,
  onMention?: (name: string) => void,
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
              onClick={() => onMention(name)}
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
      if (m) {
        flush();
        const url = m[0];
        nodes.push(
          <a key={`${keyBase}-l${k++}`} href={url} onClick={(e) => e.preventDefault()}>
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
  onMention?: (name: string) => void,
  meName?: string,
  rooms?: Rooms,
): ReactNode[] {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  /** The run of lines being gathered: bullets, numbered items, or quoted lines. */
  let run: ReactNode[] | null = null;
  let runKind: "ul" | "ol" | "quote" | null = null;
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

  const openRun = (kind: "ul" | "ol" | "quote") => {
    if (runKind !== kind) closeRun();
    runKind = kind;
    run ??= [];
    return run;
  };

  lines.forEach((line, idx) => {
    const inline = (from: string) =>
      renderInline(from, names, `${keyBase}ln${idx}`, emojiSize, onMention, meName, rooms);
    const numbered = /^(\d{1,9})[.)] /.exec(line);
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

export function renderRichText(
  text: string,
  names: string[],
  editable = false,
  onMention?: (name: string) => void,
  meName?: string,
  rooms?: Rooms,
): ReactNode {
  // Split on ``` fences: odd segments are fenced code blocks.
  const segments = text.split("```");
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
        ...renderTextBlock(replaceShortcodes(seg), names, `s${i}`, emojiSize, onMention, meName, rooms),
      );
    }
  });
  return out;
}
