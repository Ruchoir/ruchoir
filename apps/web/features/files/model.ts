/**
 * The files screen's pure logic: ordering, filtering, rights, the actions an entry offers, and
 * selection ranges. Rights, actions and move targets are shared with the apps
 * (`@ruchoir/client/filesLogic`) and re-exported here.
 *
 * It imports only those, so the module runs as is under Node's test runner (`model.test.ts`), and
 * every surface of the screen (the table, the phone rows, the grid, the menus, the keyboard) asks it
 * the same questions, so they cannot drift apart.
 */

import type { Entry } from "@ruchoir/client/filesLogic";

export { actionsFor, blockedMoveTargets, canManage, type ActionId, type Entry } from "@ruchoir/client/filesLogic";

export type SortKey = "name" | "modifiedBy" | "updatedAt" | "size";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

/** Numeric collation: "Facture 9" before "Facture 10", the way people count. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then by `sort`, the name breaking ties. Returns a new array. */
export function sortEntries<T extends Entry>(rows: T[], sort: Sort): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const by = (a: T, b: T): number => {
    switch (sort.key) {
      case "name":
        return collator.compare(a.name, b.name);
      case "modifiedBy":
        return collator.compare(a.modifiedBy, b.modifiedBy);
      case "updatedAt":
        return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
      case "size":
        return sizeOf(a) - sizeOf(b);
    }
  };
  return [...rows].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return sign * by(a, b) || collator.compare(a.name, b.name);
  });
}

function sizeOf(e: Entry): number {
  return e.isFolder ? (e.childCount ?? 0) : e.sizeBytes;
}

/** Strip case and accents, so "recap" finds "Récapitulatif". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The entries whose name contains `q`, ignoring case and accents. */
export function filterEntries<T extends Entry>(rows: T[], q: string): T[] {
  const needle = fold(q.trim());
  return needle ? rows.filter((r) => fold(r.name).includes(needle)) : rows;
}

/** The ids from `anchor` to `target` in the order shown, inclusive; just `target` without an anchor in view. */
export function rangeBetween(order: string[], anchor: string, target: string): string[] {
  const from = order.indexOf(anchor);
  const to = order.indexOf(target);
  if (to < 0) return [];
  if (from < 0) return [target];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** Shorten a name from the middle so the extension stays visible ("Rapprochement b….csv"). */
export function middleTruncate(name: string, max: number): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const base = ext ? name.slice(0, name.length - ext.length) : name;
  const keep = Math.max(4, max - ext.length - 1);
  return `${base.slice(0, keep)}…${ext}`;
}
