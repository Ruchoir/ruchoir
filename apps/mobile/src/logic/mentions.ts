/**
 * `@` and `#` in the composer: which token the cursor is in, what to suggest for it, and how the
 * chosen name replaces it. The same rules as the web's editor, so a message reads the same wherever
 * it was written: a token starts the text or follows a space (never inside a word or an e-mail
 * address), and a mention is the person's display name, whole, which is how the server resolves it.
 */

import { foldMention, offeredBroadcasts, prepareGroupNames } from "@ruchoir/client/permissionsLogic";

export type ActiveToken = { kind: "@" | "#"; query: string; start: number };

const MENTION = /(?:^|\s)@([\p{L}\p{N}_'-]*)$/u;
const CHANNEL = /(?:^|\s)#([\p{L}\p{N}_-]*)$/u;

/** The `@` that starts a token (the text start or a space before it) and what follows it up to the cursor, on one line. */
const OPEN_MENTION = /(?:^|\s)@([^\n@]*)$/u;

/** Each group name folded as the server folds it, words joined by one space (read once per list). */
const FOLDED_NAMES = new WeakMap<readonly string[], string[]>();
function foldedNames(names: readonly string[]): string[] {
  let folded = FOLDED_NAMES.get(names);
  if (!folded) FOLDED_NAMES.set(names, (folded = names.map((n) => prepareGroupNames([n]).words[0].join(" "))));
  return folded;
}

/**
 * The `@` or `#` token that ends at the cursor, or null when the cursor is not in one. Given the
 * names of the groups one may mention, an `@` token stays open across spaces and symbols while what
 * was typed (case, accents and runs of spaces ignored) is still the beginning of one of them, and
 * closes as soon as it is not.
 */
export function activeToken(text: string, cursor: number, groupNames: readonly string[] = []): ActiveToken | null {
  const before = text.slice(0, cursor);
  const mention = MENTION.exec(before);
  if (mention) return { kind: "@", query: mention[1], start: cursor - mention[1].length - 1 };
  const open = groupNames.length > 0 ? OPEN_MENTION.exec(before) : null;
  if (open) {
    const typed = open[1].replace(/\s+/g, " ");
    const needle = foldMention(typed);
    const plain = fold(typed);
    if (foldedNames(groupNames).some((n) => n.startsWith(needle)) || groupNames.some((n) => fold(n.replace(/\s+/g, " ")).startsWith(plain))) {
      return { kind: "@", query: open[1], start: cursor - open[1].length - 1 };
    }
  }
  // One hash only: `##` is a heading, and a list of channels in front of a title would be in the way.
  const channel = CHANNEL.exec(before);
  if (channel && !before.endsWith("##")) return { kind: "#", query: channel[1], start: cursor - channel[1].length - 1 };
  return null;
}

/**
 * Put `value` in place of the token, with a space after it unless one already follows, and the
 * cursor after that space, ready for the next word.
 */
export function insertToken(text: string, token: ActiveToken, value: string): { text: string; cursor: number } {
  const head = text.slice(0, token.start);
  const rest = text.slice(token.start + 1 + token.query.length);
  const inserted = `${token.kind}${value}`;
  const spaced = /^\s/.test(rest) ? rest : ` ${rest}`;
  return { text: `${head}${inserted}${spaced}`, cursor: head.length + inserted.length + 1 };
}

/** Lower case without accents, so "lea" finds "Léa" and "LE" finds "Lefèvre". */
export function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * The people whose name holds `query`, accents and case ignored: names that start with it first,
 * then a later word that does, then the rest; `limit` at most, in their order otherwise.
 */
export function matchPeople<P extends { name: string }>(people: P[], query: string, limit = 5): P[] {
  const q = fold(query.trim());
  const ranked: { person: P; rank: number }[] = [];
  for (const person of people) {
    const name = fold(person.name);
    if (!name.includes(q)) continue;
    const rank = name.startsWith(q) ? 0 : name.split(/\s+/).some((word) => word.startsWith(q)) ? 1 : 2;
    ranked.push({ person, rank });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((r) => r.person);
}

/**
 * The two names that address the room rather than a person: `@canal` reaches everyone in the
 * channel, `@ici` the people connected now. The server knows them by these names in every language.
 */
export const BROADCASTS = ["canal", "ici"] as const;

/** The broadcasts that begin with what was typed. */
export function broadcastsFor(query: string): string[] {
  return offeredBroadcasts(BROADCASTS.map((name) => ({ name })), query.trim(), true).map((b) => b.name);
}
