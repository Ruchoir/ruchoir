/**
 * Which picked files may go: those the instance accepts by size. A file whose size the phone does not
 * know, or an instance that does not say its limit, is left to the server, which answers 413.
 */
export function splitBySize<F extends { size?: number }>(files: F[], limit: number | undefined): { accepted: F[]; refused: F[] } {
  if (limit === undefined) return { accepted: files, refused: [] };
  const accepted: F[] = [];
  const refused: F[] = [];
  for (const file of files) (file.size !== undefined && file.size > limit ? refused : accepted).push(file);
  return { accepted, refused };
}
