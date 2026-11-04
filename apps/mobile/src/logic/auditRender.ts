/**
 * The journal on the phone (mockup frame 12), apart from drawing it: a line's slots as runs of
 * text (names bold, the rest plain), the pastilles under it as signed lines, the pages merged
 * without repeats, and the entries grouped by the reader's day. Free of React, so Node tests it.
 *
 * The shared `auditLine` decides which sentence a line is and what fills it; the words come from
 * the dictionary through `Words`, so nothing here is French.
 */
import type { AuditEntryLike, AuditLine, Slot } from "@ruchoir/client/permissionsLogic";

import { dayKey } from "./format.ts";

/** A marker no translation contains: where a slot goes in a translated sentence. */
export const MARK = "\u0001";

/** A piece of a line: a name is bold, the sentence around it plain. */
export type Run = { text: string; bold?: boolean };

/** The words a slot is drawn with, said by the screen from the dictionary. */
export type Words = {
  somebody: string;
  deletedAccount: string;
  aRole: string;
  aGroup: string;
  formerMembers: (count: number) => string;
  everyone: (guests: boolean) => string;
  readers: string;
  /** "sur le canal", "sur le fichier ou dossier", "sur l'agenda". */
  resourceWord: (of: "channel" | "file" | "calendar") => string;
  /** "sur un canal", for a rule whose target no list knows any more. */
  resourceUnnamed: (of: "channel" | "file" | "calendar") => string;
  theChannel: string;
  aChannel: string;
  /** A base role of an older line (`admin`, `member`, `guest`, `owner`). */
  legacy: (role: string) => string;
  /** A role as the reader names it (a system role in their language). */
  roleName: (name: string) => string;
};

const bold = (text: string): Run => ({ text, bold: true });
const plain = (text: string): Run => ({ text });

/** One slot as runs. */
export function slotRuns(slot: Slot, w: Words): Run[] {
  switch (slot.kind) {
    case "person":
      return [bold(slot.name || w.somebody)];
    case "deleted":
      return [bold(w.deletedAccount)];
    case "role":
      return [bold(slot.name ? w.roleName(slot.name) : w.aRole)];
    case "group":
      return [bold(slot.name || w.aGroup)];
    case "people": {
      const known = slot.names.filter((name): name is string => name !== null);
      const former = slot.names.length - known.length;
      const shown = [...known, ...(former > 0 ? [w.formerMembers(former)] : [])];
      return shown.flatMap((name, i) => (i > 0 ? [plain(", "), bold(name)] : [bold(name)]));
    }
    case "everyone":
      return [bold(w.everyone(slot.guests))];
    case "audience":
      return [bold(w.readers)];
    case "resource": {
      const name = slot.of === "channel" && slot.name ? `#${slot.name}` : slot.name;
      if (slot.bare) return name ? [plain(`${w.theChannel} `), bold(name)] : [plain(`${w.aChannel} `)];
      return name ? [plain(`${w.resourceWord(slot.of)} `), bold(name)] : [plain(w.resourceUnnamed(slot.of))];
    }
    case "legacy":
      return [bold(slot.roles.map((r) => w.legacy(r)).join(", "))];
  }
}

/** Joins neighbours of the same weight, so a line is as few runs as it can be. */
function tidy(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (run.text === "") continue;
    const last = out[out.length - 1];
    if (last && Boolean(last.bold) === Boolean(run.bold)) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

/**
 * A translated sentence whose slots are `MARK name MARK`, as runs. Every odd piece names a slot, so
 * the sentence keeps its own word order in every language; a name the line has no slot for is dropped.
 */
export function lineRuns(text: string, slots: Record<string, Slot>, w: Words): Run[] {
  const runs = text.split(MARK).flatMap((piece, i): Run[] => {
    if (i % 2 === 0) return [plain(piece)];
    const slot = slots[piece];
    return slot ? slotRuns(slot, w) : [];
  });
  return tidy(runs);
}

/** How the screen says a date: `long` is the day in full, `short` the day and month. */
export type DateKind = "long" | "short";

/** The variables of a line's sentence: each slot as its marker, the values as they are, dates said by the screen. */
export function fillFor(line: AuditLine, say: (iso: string, kind: DateKind) => string): Record<string, string | number> {
  const fill: Record<string, string | number> = {};
  for (const name of Object.keys(line.slots)) fill[name] = `${MARK}${name}${MARK}`;
  for (const [name, value] of Object.entries(line.values)) {
    fill[name] = name === "until" && typeof value === "string" ? say(value, "long") : name === "date" && typeof value === "string" ? say(value, "short") : value;
  }
  if (line.sentence === "licenceInstalled") fill.count = line.values.seats;
  return fill;
}

/** The words of the pastilles under a line. */
export type ChipWords = {
  permission: (name: string) => string;
  level: (name: string) => string;
  role: (name: string) => string;
  viaGroup: (role: string) => string;
  standing: (what: "member" | "guest") => string;
  until: (iso: string) => string;
  space: string;
  /** "No end date", for an access given without one. */
  noEnd: string;
};

export type SignedChip = { sign: "+" | "-"; text: string };

/** The lines that move the end of a guest's access: before and after, drawn as two pastilles. */
const DATED = new Set(["guestExpiryFixed", "guestExpiryMoved", "guestExpiryExtended", "guestExpiryAdvanced", "guestExpiryRemoved", "guestReactivated"]);

/** The rights, roles and levels gained (+) and lost (-), then a guest line's standing pastilles. */
export function chipsOf(line: AuditLine, w: ChipWords): SignedChip[] {
  const out: SignedChip[] = [];
  const diff = line.diff;
  if (diff) {
    const label = (name: string) => (diff.kind === "permission" ? w.permission(name) : diff.kind === "level" ? w.level(name) : diff.viaGroup ? w.viaGroup(w.role(name)) : w.role(name));
    for (const name of diff.added) out.push({ sign: "+", text: label(name) });
    for (const name of diff.removed) out.push({ sign: "-", text: label(name) });
  }
  for (const chip of line.chips ?? []) {
    out.push({ sign: chip.sign, text: chip.what === "until" ? w.until(chip.date ?? "") : chip.what === "space" ? w.space : w.standing(chip.what) });
  }
  if (DATED.has(line.sentence)) {
    const end = (iso: unknown) => (typeof iso === "string" && iso ? w.until(iso) : w.noEnd);
    if (line.values.after) out.push({ sign: "+", text: end(line.values.after) });
    if (line.sentence !== "guestReactivated" || line.values.before) out.push({ sign: "-", text: end(line.values.before) });
  }
  return out;
}

/** A page after the ones already loaded: what is already there is not added twice, order kept. */
export function mergePages<E extends Pick<AuditEntryLike, "at"> & { id: string }>(loaded: E[], page: E[]): E[] {
  const seen = new Set(loaded.map((e) => e.id));
  return [...loaded, ...page.filter((e) => !seen.has(e.id))];
}

/**
 * The log read again (a realtime event): its first page is merged into what is loaded, the new entries
 * on top and every page already loaded kept, so the list neither jumps nor loses its place. A pull
 * starts over instead.
 */
export function mergeFirstPage<E extends { id: string }>(loaded: E[], first: E[]): E[] {
  const seen = new Set(loaded.map((e) => e.id));
  const fresh = first.filter((e) => !seen.has(e.id));
  return fresh.length === 0 ? loaded : [...fresh, ...loaded];
}

/** The entries of each day of the reader (`YYYY-MM-DD`), in the log's order (newest first). */
export function groupEntriesByDay<E extends { at: string }>(entries: E[], timeZone: string): { day: string; entries: E[] }[] {
  const out: { day: string; entries: E[] }[] = [];
  for (const entry of entries) {
    const day = dayKey(entry.at, timeZone);
    const last = out[out.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else out.push({ day, entries: [entry] });
  }
  return out;
}
