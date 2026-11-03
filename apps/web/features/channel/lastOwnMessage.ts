/**
 * Which message the "edit my last message" shortcut opens.
 *
 * Kept apart from the screens, and free of any import, so the rule can be tested on its own.
 */

/** The fields of a message the rule reads. */
export type OwnMessageCandidate = {
  id: string;
  author: string;
  authorId?: string;
  kind?: "message" | "system";
  deleted?: boolean;
};

/**
 * The last message in `list` that `me` wrote and can still edit, or undefined.
 *
 * `list` is read oldest first, as the feed and a thread hold it. A system row, a deleted message and
 * one still on its way to the server (an optimistic `tmp-` id the API does not know yet) are skipped:
 * none of them can be edited. Authorship is decided by the user id when both sides carry one, since
 * two people may share a display name, and by the name otherwise, which is what the message menu
 * has always gone by.
 */
export function lastOwnMessage<M extends OwnMessageCandidate>(
  list: readonly M[],
  me: { id: string; name: string },
): M | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.kind === "system" || m.deleted || m.id.startsWith("tmp-")) continue;
    const mine = m.authorId && me.id ? m.authorId === me.id : !!me.name && m.author === me.name;
    if (mine) return m;
  }
  return undefined;
}
