/**
 * Which name a mention being read points at. Pure, so the rules can be tested without a browser
 * (the renderer itself is a TSX file, which `node --test` cannot load).
 */
/** The longest of `names` that `text` starts with at `from`, or null. Exact, as a person's name is. */
export function matchMention(text: string, from: number, names: string[]): string | null {
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

/**
 * The server's folding for mentions (`fold_ascii`): lowercase, then a fixed set of Latin letters
 * mapped to ASCII. Anything else, a combining mark included, is kept as typed.
 */
export function foldMention(text: string): string {
  let out = "";
  for (const ch of text) {
    for (const lc of ch.toLowerCase()) {
      if ("àáâãäå".includes(lc)) out += "a";
      else if (lc === "æ") out += "ae";
      else if (lc === "ç") out += "c";
      else if ("èéêë".includes(lc)) out += "e";
      else if ("ìíîï".includes(lc)) out += "i";
      else if (lc === "ñ") out += "n";
      else if ("òóôõö".includes(lc)) out += "o";
      else if (lc === "œ") out += "oe";
      else if ("ùúûü".includes(lc)) out += "u";
      else if ("ýÿ".includes(lc)) out += "y";
      else out += lc;
    }
  }
  return out;
}

const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * The longest group name `text` addresses at `from` (just after an `@`), as typed, or null. This is
 * the server's rule (`whole_name_mentioned`), so a pill lights exactly when a notification goes out:
 * the `@` must not follow a handle character ("jean@ops.fr" is an address); the name is compared word
 * by word after splitting on any whitespace, each typed word losing only trailing `. , ; : ! ?`,
 * both sides folded with the server's table. So "@Chantier  Rennes" (two spaces, a newline) is the
 * group, "@Ops)" and "@Ops's" are not. The length returned is the typed text, trailing punctuation
 * excluded.
 */
export function matchGroupMention(text: string, from: number, names: string[]): string | null {
  if (from >= 2 && isHandleChar(text[from - 2])) return null;
  const rest = text.slice(from);
  const words = [...rest.matchAll(/\S+/g)];
  // The server skips leading whitespace after the @; a pill never starts with a space, so a mention
  // must begin right at `from`.
  if (words.length === 0 || words[0].index !== 0) return null;
  let best: string | null = null;
  for (const n of names) {
    const wanted = n
      .split(/\s+/)
      .map(foldMention)
      .filter((w) => w !== "");
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
      end = (w.index ?? 0) + trimmed.length;
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
  people: string[],
  groups: string[],
): { kind: "person" | "group"; name: string } | null {
  const person = matchMention(text, from, people);
  const group = matchGroupMention(text, from, groups);
  if (group && (!person || group.length > person.length)) return { kind: "group", name: group };
  return person ? { kind: "person", name: person } : null;
}
