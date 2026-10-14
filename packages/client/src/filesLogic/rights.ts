/**
 * Who may do what with a file or a folder, and what a move may not land in: the rules every menu of
 * the web and the apps asks, so they cannot drift apart. The server stays the judge.
 *
 * Imports nothing, so Node's test runner runs it as is (`test/filesRights.test.ts`).
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
  /** Kept among the person's favourites. */
  starred?: boolean;
};

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

export type ActionId = "open" | "download" | "share" | "star" | "rename" | "move" | "newVersion" | "versions" | "details" | "delete";

/** The actions an entry offers, in the order every menu shows them. */
export function actionsFor(entry: Entry, manage: boolean): ActionId[] {
  if (!entry.id) return ["details"];
  const out: ActionId[] = ["open"];
  // Sharing (into a conversation, by public link) is a file's: an attachment and a link are files.
  if (!entry.isFolder) out.push("download", "share");
  // A favourite is the person's own: anyone who sees the entry may keep it at hand.
  out.push("star");
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

/**
 * Folders a move may not land in: the folders being moved. Their descendants are out of reach as
 * well, since the picker cannot enter a blocked folder to get to them.
 */
export function blockedMoveTargets(moving: Entry[]): Set<string> {
  return new Set(moving.filter((e) => e.isFolder && e.id).map((e) => e.id as string));
}
