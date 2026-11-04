/**
 * What the groups screens decide without drawing anything: who gets a role through which group, what
 * locks a row of the list, how the list is ordered and which groups a typed mention reaches. The API
 * decides what is allowed (each group's `may` block); this only says it in the screen's terms.
 */
import type { RoleLike } from "./roles.ts";

/** A group as these helpers read it (`Group` from the client, the fields used here). */
export type GroupLike = {
  id: string;
  name: string;
  source: "manual" | "directory";
  memberIds: string[];
  managerIds: string[];
  roleIds: string[];
};

/** The longest description a group takes, the server's own limit (`DESCRIPTION_MAX` in `group_routes.rs`, checked by a test). */
export const GROUP_DESCRIPTION_MAX = 280;

/** The longest group name, as the web and the phone cap the field. */
export const GROUP_NAME_MAX = 60;

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
 * The groups a mention being typed offers: those whose name begins with the query (as one types a
 * name), by name, with how many
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
    .filter((g) => foldName(g.name).startsWith(needle))
    .map((group) => ({ group, members: group.memberIds.length, inRoom: group.memberIds.filter((id) => room.has(id)).length }));
}

/** Whether a person holds a role: given directly or received through one of their groups. */
export function holdsRole(member: { userId: string; roleIds?: string[] }, roleId: string, groups: GroupLike[]): boolean {
  return !!member.roleIds?.includes(roleId) || rolesViaGroups(member, groups).has(roleId);
}

/** The groups a person is in, by name. */
export function groupsOf<G extends Pick<GroupLike, "name" | "memberIds">>(userId: string, groups: G[]): G[] {
  return sortGroups(groups.filter((g) => g.memberIds.includes(userId)));
}

/**
 * Who holds a role, for the role editor's people tab: those given it directly, then each group that
 * carries it with the people it holds (`members` in the space's order), and every holder once.
 */
export function rolePeople<M extends { userId: string; roleIds?: string[] }, G extends GroupLike>(
  roleId: string,
  members: M[],
  groups: G[],
): { direct: M[]; viaGroups: { group: G; members: M[] }[]; holderIds: string[] } {
  const direct = members.filter((m) => m.roleIds?.includes(roleId));
  const viaGroups = sortGroups(groups.filter((g) => g.roleIds.includes(roleId))).map((group) => ({
    group,
    members: members.filter((m) => group.memberIds.includes(m.userId)),
  }));
  const holderIds = new Set(direct.map((m) => m.userId));
  for (const v of viaGroups) for (const m of v.members) holderIds.add(m.userId);
  return { direct, viaGroups, holderIds: [...holderIds] };
}

/**
 * The people of a group that the space still has, in the group's order, and how many ids point at
 * someone no longer in it. Headers show the first count, so they match the rows drawn.
 */
export function groupPeople<M extends { userId: string }>(group: Pick<GroupLike, "memberIds">, members: M[]): { people: M[]; missing: number } {
  const byId = new Map(members.map((m) => [m.userId, m]));
  const people = group.memberIds.map((id) => byId.get(id)).filter((m): m is M => !!m);
  return { people, missing: group.memberIds.length - people.length };
}

/**
 * The dictionary key for the server's `no_self_role` refusal, by what was being done: changing the
 * roles of a group one is in ("roles"), or putting oneself in a group that carries some ("members").
 */
export function selfRoleKey(context: "roles" | "members"): "groups.noSelfRole" | "groups.noSelfJoin" {
  return context === "members" ? "groups.noSelfJoin" : "groups.noSelfRole";
}
