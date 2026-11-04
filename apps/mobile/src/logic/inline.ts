/**
 * The inline part of a message's Markdown, cut into segments the app draws: mentions, bold,
 * italic, code and bare links. Block shapes (quotes, lists, fences) are handled line by line by the
 * message row; this file only reads within a line.
 *
 * Mentions are recognised against the names the server resolves (`getMentionNames` on the web):
 * the longest one that follows an `@` wins, so "@Camille Roux" is one mention, not "@Camille" and a
 * stray " Roux". Group names are read by the shared matcher (`@ruchoir/client`), which folds their
 * words once per list: hand it the same array while the groups do not change.
 */
import { matchGroupMention, type PreparedGroupNames } from "@ruchoir/client/permissionsLogic";

export type Segment = { kind: "text" | "mention" | "group" | "bold" | "italic" | "code" | "link"; text: string };

const TOKEN = /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(?<![\w*])([_*])([^_*\n]+)\3(?![\w*])|(https?:\/\/[^\s<>()]+)|(@)/g;

export function parseInline(line: string, names: readonly string[], groups: readonly string[] | PreparedGroupNames = []): Segment[] {
  const hasGroups = "words" in groups ? groups.maxWords > 0 : groups.length > 0;
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const out: Segment[] = [];
  const push = (kind: Segment["kind"], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (kind === "text" && last?.kind === "text") last.text += text;
    else out.push({ kind, text });
  };
  let at = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(line); m; m = TOKEN.exec(line)) {
    if (m[6]) {
      // `@`: a person if a known name follows as a whole word, a group if its name does (the
      // server's rule); the longer wins, and a person at equal length, as on the web.
      const rest = line.slice(m.index + 1);
      const name = sorted.find(
        (n) => rest.toLowerCase().startsWith(n.toLowerCase()) && !/[\p{L}\p{N}]/u.test(rest.charAt(n.length)),
      );
      const group = hasGroups ? matchGroupMention(line, m.index + 1, groups) : null;
      if (!name && !group) continue;
      const isGroup = !!group && (!name || group.length > name.length);
      const length = isGroup ? group!.length : name!.length;
      push("text", line.slice(at, m.index));
      push(isGroup ? "group" : "mention", `@${rest.slice(0, length)}`);
      at = m.index + 1 + length;
      TOKEN.lastIndex = at;
      continue;
    }
    push("text", line.slice(at, m.index));
    if (m[1]) push("bold", m[1].slice(2, -2));
    else if (m[2]) push("code", m[2].slice(1, -1));
    else if (m[4]) push("italic", m[4]);
    else if (m[5]) {
      // A sentence's full stop or comma after a link belongs to the sentence.
      const url = m[5].replace(/[.,;:!?]+$/, "");
      push("link", url);
      TOKEN.lastIndex = m.index + url.length;
      at = TOKEN.lastIndex;
      continue;
    }
    at = m.index + m[0].length;
  }
  push("text", line.slice(at));
  return out;
}

/** One plain line of a message, for a preview: no Markdown marks, no line breaks. */
export function plainExcerpt(body: string): string {
  return body
    .split("\n")
    .map((line) => line.replace(/^\s*(>|[-*+]|\d+\.)\s+/, "").replace(/^```.*$/, ""))
    .join(" ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|\s)[_*]([^_*]+)[_*](?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}
