/**
 * Finding a message further up a conversation (a pinned one, say): older pages are fetched one after
 * the other until one holds it, the beginning of the conversation is reached, or `maxPages` were
 * read. What was fetched is handed back whole, so the screen keeps it, with where to carry on from.
 */
export async function seekMessage<M extends { id: string }>(
  fetchPage: (before: string) => Promise<{ messages: M[]; nextBefore?: string }>,
  before: string | undefined,
  targetId: string,
  maxPages = 30,
): Promise<{ messages: M[]; nextBefore: string; found: boolean }> {
  const messages: M[] = [];
  let cursor = before ?? "";
  for (let read = 0; cursor && read < maxPages; read++) {
    const page = await fetchPage(cursor);
    messages.push(...page.messages);
    cursor = page.nextBefore ?? "";
    if (page.messages.some((m) => m.id === targetId)) return { messages, nextBefore: cursor, found: true };
  }
  return { messages, nextBefore: cursor, found: false };
}
