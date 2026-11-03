/**
 * Which name a mention being read points at. Pure, so the rules can be tested without a browser
 * (the renderer itself is a TSX file, which `node --test` cannot load).
 */
import { foldName } from "../settings/groupsLogic.ts";

/** The longest of `names` that `text` starts with at `from`, or null. Exact, as a person's name is. */
export function matchMention(text: string, from: number, names: string[]): string | null {
  const rest = text.slice(from);
  let best: string | null = null;
  for (const n of names) {
    if (rest.startsWith(n) && (!best || n.length > best.length)) best = n;
  }
  return best;
}

/**
 * The longest group name `text` starts with at `from`, written as it was typed. The server reads
 * `@` and the group's whole name, accents and case folded, so "@comptabilite" reaches "Comptabilité";
 * and the name is whole, spaces included ("@Chantier Rennes").
 */
export function matchGroupMention(text: string, from: number, names: string[]): string | null {
  const rest = text.slice(from);
  let best: string | null = null;
  for (const n of names) {
    if (best && n.length <= best.length) continue;
    if (n.length > 0 && foldName(rest.slice(0, n.length)) === foldName(n)) best = rest.slice(0, n.length);
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
