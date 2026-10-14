/**
 * The pure part of sending files: free names, the size cap, and the folders a dropped tree needs.
 * Free names are shared with the apps (`@ruchoir/client/filesLogic`).
 *
 * Imports only that, so Node's own runner tests it as is (`uploadPlan.test.ts`).
 */

export { isTaken, uniqueName } from "@ruchoir/client/filesLogic";

/** Whether a file is over the instance's cap (none known: no limit to check). */
export function tooLarge(size: number, max: number | undefined): boolean {
  return max != null && size > max;
}

/** A relative path ("Photos/2026/a.jpg") as its folders and its name. */
export function splitPath(path: string): { dirs: string[]; name: string } {
  const parts = path.split("/").filter(Boolean);
  return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] ?? "" };
}

/** Every folder a set of relative paths needs, once each, a parent always before its children. */
export function folderPaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const { dirs } = splitPath(path);
    for (let i = 1; i <= dirs.length; i++) {
      const folder = dirs.slice(0, i).join("/");
      if (!seen.has(folder)) {
        seen.add(folder);
        out.push(folder);
      }
    }
  }
  return out;
}
