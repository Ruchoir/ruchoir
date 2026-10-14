/**
 * Free names in a folder, as the web and the apps send files: names compare without case, and a
 * taken one gets the first free number before its extension ("keep both").
 *
 * Imports nothing, so Node's test runner runs it as is (`test/filesNames.test.ts`).
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
