/**
 * What the groups screens decide without drawing anything: who gets a role through which group, what
 * locks a row of the list, how the list is ordered and which groups a typed mention reaches. The API
 * decides what is allowed (each group's `may` block); this only says it in the screen's terms.
 */
import type { RoleLike } from "./rolesLogic.ts";

/** A group as these helpers read it (`Group` from the client, the fields used here). */
export type GroupLike = {
  id: string;
  name: string;
  source: "manual" | "directory";
  memberIds: string[];
  managerIds: string[];
  roleIds: string[];
};

/** Names compare without case or accents: "été" sits with the e's, "COMPTABILITE" finds "Comptabilité". */
export function foldName(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The groups in the order the list shows them: by name. */
export function sortGroups<G extends Pick<GroupLike, "name">>(groups: G[]): G[] {
  return [...groups].sort((a, b) => foldName(a.name).localeCompare(foldName(b.name)) || a.name.localeCompare(b.name));
}

/** The roles a member holds through groups, each with the names of the groups that give it. */
export function rolesViaGroups(member: { userId: string }, groups: GroupLike[]): Map<string, string[]> {
  const via = new Map<string, string[]>();
  for (const group of groups) {
    if (!group.memberIds.includes(member.userId)) continue;
    for (const roleId of group.roleIds) via.set(roleId, [...(via.get(roleId) ?? []), group.name]);
  }
  return via;
}

/**
 * What a row of the list shows for a group: the roles it carries, and why it does not open for
 * changes. `above`: it carries a role placed above the viewer's own. `frozen`: the licence expired
 * and it carries roles (a group without any stays free in every edition).
 */
export function groupRow<R extends RoleLike>(
  group: Pick<GroupLike, "roleIds">,
  roles: R[],
  ctx: { frozen: boolean },
): { carries: R[]; locked: "above" | "frozen" | null } {
  const carries = roles.filter((r) => group.roleIds.includes(r.id));
  if (carries.some((r) => !r.manageable)) return { carries, locked: "above" };
  if (ctx.frozen && carries.length > 0) return { carries, locked: "frozen" };
  return { carries, locked: null };
}

/**
 * The groups a mention being typed offers: those whose name holds the query, by name, with how many
 * people they hold and how many of those are in the room the message goes to (`audienceIds`).
 */
export function groupMentionHits<G extends GroupLike>(
  groups: G[],
  query: string,
  audienceIds: string[],
): { group: G; members: number; inRoom: number }[] {
  const needle = foldName(query.trim());
  const room = new Set(audienceIds);
  return sortGroups(groups)
    .filter((g) => foldName(g.name).includes(needle))
    .map((group) => ({ group, members: group.memberIds.length, inRoom: group.memberIds.filter((id) => room.has(id)).length }));
}
