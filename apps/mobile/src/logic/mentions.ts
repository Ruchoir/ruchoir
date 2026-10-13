/**
 * `@` and `#` in the composer: which token the cursor is in, what to suggest for it, and how the
 * chosen name replaces it. The same rules as the web's editor, so a message reads the same wherever
 * it was written: a token starts the text or follows a space (never inside a word or an e-mail
 * address), and a mention is the person's display name, whole, which is how the server resolves it.
 */

export type ActiveToken = { kind: "@" | "#"; query: string; start: number };

const MENTION = /(?:^|\s)@([\p{L}\p{N}_'-]*)$/u;
const CHANNEL = /(?:^|\s)#([\p{L}\p{N}_-]*)$/u;

/** The `@` or `#` token that ends at the cursor, or null when the cursor is not in one. */
export function activeToken(text: string, cursor: number): ActiveToken | null {
  const before = text.slice(0, cursor);
  const mention = MENTION.exec(before);
  if (mention) return { kind: "@", query: mention[1], start: cursor - mention[1].length - 1 };
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
  const q = fold(query.trim());
  return BROADCASTS.filter((name) => name.startsWith(q));
}
