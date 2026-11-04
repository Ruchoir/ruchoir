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

/**
 * What sending does with the files waiting in a draft. Without the right to attach here
 * (`message.attach` lost since they were picked) the files are kept in the draft, marked, and left
 * out of the message: only the text goes, and with no text there is nothing to send. The person is
 * told by a sentence under the chips, so no send is refused silently by the server.
 */
export function sendPlan(s: { canAttach: boolean; body: string; pending: number; waiting: boolean }): { ready: boolean; withFiles: boolean; blocked: boolean } {
  if (!s.canAttach) return { ready: s.body.length > 0, withFiles: false, blocked: s.pending > 0 };
  return { ready: (s.body.length > 0 || s.pending > 0) && !s.waiting, withFiles: true, blocked: false };
}
