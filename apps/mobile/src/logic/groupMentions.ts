/**
 * Group mentions on the phone: how a typed `@` offers groups and how a message names one. The
 * rules are the server's (`whole_name_mentioned`) and the web's (`mentionMatch.ts`, the composer),
 * so a pill lights exactly when a notification goes out and a message reads the same everywhere.
 * The body carries nothing but the name: `@Comptabilité`, `@Chantier Rennes`.
 */
import type { Group } from "@ruchoir/client";
import { foldName, groupHitsFor } from "@ruchoir/client/permissionsLogic";

/** Whether a character may appear in a mention handle, as the server reads it (`is_handle_char`). */
function isHandleChar(c: string): boolean {
  return /[\p{L}\p{N}]/u.test(c) || c === "." || c === "_" || c === "-";
}

/** The Latin letters the server maps to ASCII (`fold_ascii`); anything else is kept as typed. */
const FOLD: Record<string, string> = {
  "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "å": "a", "ç": "c",
  "è": "e", "é": "e", "ê": "e", "ë": "e", "ì": "i", "í": "i", "î": "i",
  "ï": "i", "ñ": "n", "ò": "o", "ó": "o", "ô": "o", "õ": "o", "ö": "o",
  "ù": "u", "ú": "u", "û": "u", "ü": "u", "ý": "y", "ÿ": "y", "æ": "ae", "œ": "oe",
};

/** The server's folding for mentions: lowercase, then the fixed table above. */
export function foldMention(text: string): string {
  let out = "";
  for (const ch of text) for (const lc of ch.toLowerCase()) out += FOLD[lc] ?? lc;
  return out;
}

const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * The longest group name `text` addresses at `from` (just after an `@`), as typed, or null: the
 * `@` must not follow a handle character (an address), the name is compared word by word on any
 * whitespace, each typed word losing only trailing `. , ; : ! ?`, both sides folded.
 */
export function matchGroupMention(text: string, from: number, names: readonly string[]): string | null {
  if (from >= 2 && isHandleChar(text[from - 2])) return null;
  const rest = text.slice(from);
  const words = [...rest.matchAll(/\S+/g)];
  if (words.length === 0 || words[0].index !== 0) return null;
  let best: string | null = null;
  for (const n of names) {
    const wanted = n.split(/\s+/).map(foldMention).filter((w) => w !== "");
    if (wanted.length === 0 || wanted.length > words.length) continue;
    let ok = true;
    let end = 0;
    for (let k = 0; k < wanted.length; k++) {
      const word = words[k];
      const trimmed = word[0].replace(TRAILING_PUNCTUATION, "");
      if (foldMention(trimmed) !== wanted[k]) {
        ok = false;
        break;
      }
      end = (word.index ?? 0) + trimmed.length;
    }
    if (ok && (!best || end > best.length)) best = rest.slice(0, end);
  }
  return best;
}

/** The group a pill names (`@comptabilite`, spaces as typed), by the same folding. */
export function groupByName<G extends Pick<Group, "name">>(groups: readonly G[], mention: string): G | undefined {
  const wanted = foldName(mention.replace(/^@/, "").replace(/\s+/g, " ").trim());
  return groups.find((g) => foldName(g.name.replace(/\s+/g, " ").trim()) === wanted);
}

/** The groups a mention being typed offers (none for a guest), with how many people each holds. */
export function mentionableGroups<G extends Pick<Group, "id" | "name" | "source" | "memberIds" | "managerIds" | "roleIds">>(
  viewerRole: string | undefined,
  groups: G[],
  query: string,
) {
  return groupHitsFor(viewerRole, groups, query, []);
}

export type OrderedHit<R, G, P> =
  | { kind: "room"; item: R }
  | { kind: "group"; item: G }
  | { kind: "person"; item: P };

/** What the menu lists: the room-wide names, then groups, then people (the web's order), `limit` in all. */
export function mentionOrder<R, G, P>(parts: { rooms: R[]; groups: G[]; people: P[] }, limit: number): OrderedHit<R, G, P>[] {
  const all: OrderedHit<R, G, P>[] = [
    ...parts.rooms.map((item) => ({ kind: "room" as const, item })),
    ...parts.groups.map((item) => ({ kind: "group" as const, item })),
    ...parts.people.map((item) => ({ kind: "person" as const, item })),
  ];
  return all.slice(0, limit);
}
