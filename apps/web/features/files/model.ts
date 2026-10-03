/**
 * The files screen's pure logic: ordering, filtering, rights, the actions an entry offers, and
 * selection ranges.
 *
 * Nothing here imports anything, on purpose: the module runs as is under Node's test runner
 * (`model.test.ts`), and every surface of the screen (the table, the phone rows, the grid, the
 * menus, the keyboard) asks it the same questions, so they cannot drift apart.
 */

/** What this module needs of an entry. `SpaceFile` maps onto it through `entryOf` (`listTypes.ts`). */
export type Entry = {
  /** Absent for an entry the API cannot address. */
  id?: string;
  name: string;
  isFolder: boolean;
  sizeBytes: number;
  /** A folder's number of direct entries. */
  childCount?: number;
  /** Last change, RFC 3339. */
  updatedAt: string;
  /** Who changed it last (the owner when unknown). */
  modifiedBy: string;
  ownerId?: string;
  parentFolderId?: string;
};

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

/**
 * Whether the person may rename, move, delete or replace an entry.
 *
 * The same rule as the server's (`apps/api/src/files/authz.rs`, `ensure_readable`'s `can_edit`):
 * the entry's owner, or an owner or administrator of the space. Computed here rather than sent per
 * entry because `files.updated` reaches every member with the same payload. The server stays the
 * judge: this only keeps the interface from offering what would be refused.
 */
export function canManage(entry: { ownerId?: string }, me: string | undefined, spaceRole: string | undefined): boolean {
  if (spaceRole === "owner" || spaceRole === "admin") return true;
  return !!me && entry.ownerId === me;
}

export type ActionId = "open" | "download" | "rename" | "move" | "newVersion" | "versions" | "details" | "delete";

/** The actions an entry offers, in the order every menu shows them. */
export function actionsFor(entry: Entry, manage: boolean): ActionId[] {
  if (!entry.id) return ["details"];
  const out: ActionId[] = ["open"];
  if (!entry.isFolder) out.push("download");
  if (manage) {
    out.push("rename", "move");
    if (!entry.isFolder) out.push("newVersion");
  }
  // Any reader may look at a file's history and download an old version; bringing one back is
  // offered inside it, to those who may.
  if (!entry.isFolder) out.push("versions");
  out.push("details");
  if (manage) out.push("delete");
  return out;
}

/** The ids from `anchor` to `target` in the order shown, inclusive; just `target` without an anchor in view. */
export function rangeBetween(order: string[], anchor: string, target: string): string[] {
  const from = order.indexOf(anchor);
  const to = order.indexOf(target);
  if (to < 0) return [];
  if (from < 0) return [target];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/**
 * Folders a move may not land in: the folders being moved. Their descendants are out of reach as
 * well, since the picker cannot enter a blocked folder to get to them.
 */
export function blockedMoveTargets(moving: Entry[]): Set<string> {
  return new Set(moving.filter((e) => e.isFolder && e.id).map((e) => e.id as string));
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
