import { FAMILIES } from "./roles.ts";

/**
 * What the caller holds in a space, by permission name. An instance older than the permissions
 * says nothing: its owners and administrators held everything, the others nothing of what the
 * administration gates.
 */
export function rightsOf(space: { role: string; myPermissions?: string[] } | undefined): string[] {
  if (!space) return [];
  if (space.myPermissions) return space.myPermissions;
  return ["owner", "admin"].includes(space.role) ? FAMILIES.flatMap((f) => f.permissions) : [];
}

/**
 * The doors of a space's administration, each on the right the API checks behind it: a custom role
 * that manages people reaches the members, one that does not set up the space never sees its
 * arrival channel. The owner always reaches the settings, the space's identity being theirs alone.
 */
export function spaceGates(role: string | undefined, rights: string[]) {
  const has = (p: string) => rights.includes(p);
  return {
    openSettings: role === "owner" || ["space.settings", "members.manage", "roles.manage", "groups.manage", "audit.view"].some(has),
    invite: has("members.invite"),
    managePeople: has("members.manage") || has("roles.manage"),
    readAudit: has("audit.view"),
    manageGroups: has("groups.manage"),
    setDefaultChannel: has("space.settings"),
    reorderChannels: has("space.settings"),
    deleteChannels: has("channels.delete"),
    addPeopleToChannels: has("channel.members.manage"),
  };
}

/**
 * Whether the caller may make someone an administrator, by invitation or otherwise: rule 1, a role
 * is given by whoever holds `roles.manage` and ranks strictly above it. The owner always does; an
 * administrator does not (Administrator is their own rank); a role the owner placed above
 * Administrator may. Positions are the roles' (`Role.position`).
 */
export function canGiveAdministrator(
  role: string | undefined,
  rights: string[],
  positions: { myTop?: number; administrator?: number },
): boolean {
  if (role === "owner") return true;
  if (!rights.includes("roles.manage")) return false;
  return positions.myTop !== undefined && positions.administrator !== undefined && positions.myTop > positions.administrator;
}
