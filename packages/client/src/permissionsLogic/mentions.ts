/**
 * Which name a mention being read points at, shared by the web and the apps so a pill lights
 * exactly when the server sends a notification. Pure, so the rules can be tested without a browser.
 */

/**
 * The words that address the whole room, folded as the server folds them (`CHANNEL_HANDLES` in
 * `messaging/mentions.rs`; a test reads that file): `@channel`, `@canal`, `@Kanal`, `@canale`, and
 * the older `@everyone`, `@all`, `@tous`.
 */
export const ROOM_HANDLES: readonly string[] = ["channel", "everyone", "all", "canal", "tous", "kanal", "canale"];

/** The words that address the people connected now, folded (`HERE_HANDLES` in `mentions.rs`). */
export const PRESENT_HANDLES: readonly string[] = ["here", "ici", "hier", "aqui", "qui", "tutaj"];

/** How the interface writes the two handles that carry an accent, besides the folded form. */
// i18n-audit-ignore-next-line: protocol words the server accepts, not interface prose
const ACCENTED_HANDLES = ["aquí", "kanał"];

/**
 * Every spelling of a room-wide handle a message is highlighted for: each folded handle, its
 * capitalised form and the accented ones the dictionaries show. One list for the web and the apps.
 */
export function broadcastMentionNames(): string[] {
  const base = [...ROOM_HANDLES, ...PRESENT_HANDLES, ...ACCENTED_HANDLES];
  return [...new Set(base.flatMap((h) => [h, h[0].toUpperCase() + h.slice(1)]))];
}

/** The longest of `names` that `text` starts with at `from`, or null. Exact, as a person's name is. */
export function matchMention(text: string, from: number, names: readonly string[]): string | null {
  const rest = text.slice(from);
  let best: string | null = null;
  for (const n of names) {
    if (rest.startsWith(n) && (!best || n.length > best.length)) best = n;
  }
  return best;
}

/** Whether a character may appear in a mention handle, as the server reads it (`is_handle_char`). */
function isHandleChar(c: string): boolean {
  return /[\p{L}\p{N}]/u.test(c) || c === "." || c === "_" || c === "-";
}

/** The Latin letters the server maps to ASCII, as code points (`fold_ascii`). */
const FOLD: Record<string, string> = { "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "å": "a", "ç": "c", "ł": "l", "è": "e", "é": "e", "ê": "e", "ë": "e", "ì": "i", "í": "i", "î": "i", "ï": "i", "ñ": "n", "ò": "o", "ó": "o", "ô": "o", "õ": "o", "ö": "o", "ù": "u", "ú": "u", "û": "u", "ü": "u", "ý": "y", "ÿ": "y", "æ": "ae", "œ": "oe" };

/**
 * The server's folding for mentions (`fold_ascii`): lowercase, then a fixed set of Latin letters
 * mapped to ASCII. Anything else, a combining mark included, is kept as typed.
 */
export function foldMention(text: string): string {
  let out = "";
  for (const ch of text) for (const lc of ch.toLowerCase()) out += FOLD[lc] ?? lc;
  return out;
}

/** Group names with their words already folded, so a message is not read against them name by name from scratch. */
export type PreparedGroupNames = {
  names: readonly string[];
  /** For each name, its folded words. */
  words: string[][];
  /** The word count of the longest name: no need to look further than that after an `@`. */
  maxWords: number;
};

const PREPARED = new WeakMap<readonly string[], PreparedGroupNames>();

/** Fold the words of `names` once; the same list (same array) gives the same structure back. */
export function prepareGroupNames(names: readonly string[]): PreparedGroupNames {
  const known = PREPARED.get(names);
  if (known) return known;
  const words = names.map((n) => n.split(/\s+/).map(foldMention).filter((w) => w !== ""));
  const prepared = { names, words, maxWords: words.reduce((m, w) => Math.max(m, w.length), 0) };
  PREPARED.set(names, prepared);
  return prepared;
}

const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** The code point that ends `text`, read as a whole when it is a surrogate pair. */
function lastCodePoint(text: string): string {
  const tail = text.slice(-2);
  return tail.length === 2 && /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(tail) ? tail : text.slice(-1);
}

/**
 * The longest group name `text` addresses at `from` (just after an `@`), as typed, or null. This is
 * the server's rule (`whole_name_mentioned`), so a pill lights exactly when a notification goes out:
 * the `@` must not follow a handle character ("jean@ops.fr" is an address); the name is compared word
 * by word after splitting on any whitespace, each typed word losing only trailing `. , ; : ! ?`,
 * both sides folded with the server's table. So "@Chantier  Rennes" (two spaces, a newline) is the
 * group, "@Ops)" and "@Ops's" are not. The length returned is the typed text, trailing punctuation
 * excluded. Hand it `prepareGroupNames(names)` when the same names are read many times.
 */
export function matchGroupMention(text: string, from: number, names: readonly string[] | PreparedGroupNames): string | null {
  const prepared = "words" in names ? names : prepareGroupNames(names);
  if (prepared.maxWords === 0) return null;
  if (from >= 2 && isHandleChar(lastCodePoint(text.slice(0, from - 1)))) return null;
  const rest = text.slice(from);
  // Only the words a name could span: the rest of a long message is not read.
  const words: RegExpExecArray[] = [];
  const word = /\S+/g;
  for (let m = word.exec(rest); m && words.length < prepared.maxWords; m = word.exec(rest)) words.push(m);
  // The server skips leading whitespace after the @; a pill never starts with a space, so a mention
  // must begin right at `from`.
  if (words.length === 0 || words[0].index !== 0) return null;
  let best: string | null = null;
  for (const wanted of prepared.words) {
    if (wanted.length === 0 || wanted.length > words.length) continue;
    let ok = true;
    let end = 0;
    for (let k = 0; k < wanted.length; k++) {
      const w = words[k];
      const trimmed = w[0].replace(TRAILING_PUNCTUATION, "");
      if (foldMention(trimmed) !== wanted[k]) {
        ok = false;
        break;
      }
      end = w.index + trimmed.length;
    }
    if (ok && (!best || end > best.length)) best = rest.slice(0, end);
  }
  return best;
}

/**
 * What a mention at `from` reads as: a person (or a room-wide handle) or a group. The longest name
 * wins, so `@Chantier Rennes` is the group even when someone is called Chantier, and a group named
 * "Marie Dupont Fans" beats the person "Marie Dupont" it begins with. At equal length the person
 * wins: a name that exists as both has always been the person's.
 */
export function matchMentionTarget(
  text: string,
  from: number,
  people: readonly string[],
  groups: readonly string[] | PreparedGroupNames,
): { kind: "person" | "group"; name: string } | null {
  const person = matchMention(text, from, people);
  const group = matchGroupMention(text, from, groups);
  if (group && (!person || group.length > person.length)) return { kind: "group", name: group };
  return person ? { kind: "person", name: person } : null;
}

/**
 * The room-wide handles (`@canal`, `@ici`) a composer suggests for what was typed. None where the
 * person does not hold `message.mention_all` there (`channelGates(...).mentionAll`): the server
 * refuses them, so they are not offered.
 */
export function offeredBroadcasts<T extends { name: string }>(all: readonly T[], query: string, allowed: boolean): T[] {
  if (!allowed) return [];
  const q = foldMention(query);
  // A handle is offered under the word the interface uses (`canal`), found by any word of its kind:
  // typing "kan" or "chan" finds the room-wide one, "qu" or "tut" the people connected.
  return all.filter((b) => {
    const kind = ROOM_HANDLES.includes(foldMention(b.name)) ? ROOM_HANDLES : PRESENT_HANDLES.includes(foldMention(b.name)) ? PRESENT_HANDLES : [foldMention(b.name)];
    return kind.some((h) => h.startsWith(q));
  });
}
