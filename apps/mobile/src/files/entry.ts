import type { SpaceFile } from "@ruchoir/client";
import type { Entry } from "@ruchoir/client/filesLogic";

/** A space file as the shared files rules see it (`@ruchoir/client/filesLogic`). */
export function entryOf(file: SpaceFile): Entry {
  return {
    id: file.id,
    name: file.name,
    isFolder: file.kind === "folder",
    sizeBytes: file.sizeBytes,
    childCount: file.childCount,
    updatedAt: file.updatedAt,
    modifiedBy: file.modifiedBy ?? file.by,
    ownerId: file.ownerId,
    parentFolderId: file.parentFolderId,
    starred: file.starred,
  };
}
