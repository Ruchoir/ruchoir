/**
 * The pure part of sending files: free names, the size cap, and the folders a dropped tree needs.
 *
 * No imports, like `model.ts`, so Node's own runner tests it as is (`uploadPlan.test.ts`).
 */

/** Names compare without case: "Facture.pdf" and "facture.PDF" are the same file to the person sending it. */
function fold(name: string): string {
  return name.toLowerCase();
}

/** Whether `name` is already used among `taken`. */
export function isTaken(name: string, taken: Iterable<string>): boolean {
  const wanted = fold(name);
  for (const n of taken) if (fold(n) === wanted) return true;
  return false;
}

/**
 * `name`, or the first "name (n).ext" not among `taken`: the "keep both" of a duplicate. The number
 * goes before the last extension, so the file still opens with what it opened with.
 */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const list = [...taken];
  if (!isTaken(name, list)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!isTaken(candidate, list)) return candidate;
  }
}

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
