/**
 * What the roles screens decide without drawing anything: the permission families, the state of
 * each row of the role editor, the changes being saved, the orders the viewer may set, and what a
 * member's "Gestion" tab offers. The API is the judge; this keeps the screen from offering what it
 * would refuse, and says why.
 */

/** The longest name a role takes, the server's own limit (`validate_role_name` in `roles.rs`, checked by a test). */
export const ROLE_NAME_MAX = 40;

/** The count shown beside a capped field ("9/40"), counted like `maxLength` counts so the two agree. */
export function charCount(value: string, max: number): string {
  return `${value.length}/${max}`;
}

/** The pastels a role may wear, in the server's order (`ROLE_COLOURS` in `roles.rs`, checked by a test): colour keys, not theme values. */
export const ROLE_COLOURS = ["sky", "mint", "violet", "pink", "peach", "lime", "sun"] as const;
export type RoleColourKey = (typeof ROLE_COLOURS)[number];

/** The pastel a group's square wears, always the same for the same group. */
export function groupColour(id: string): RoleColourKey {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return ROLE_COLOURS[hash % ROLE_COLOURS.length];
}

/** A role as these helpers read it (`Role` from the client, the fields used here). */
export type RoleLike = {
  id: string;
  systemKey?: "administrator" | "members" | "guests";
  permissions: string[];
  manageable: boolean;
};

/** The catalogue in four families, in its order (`apps/api/src/permissions/catalogue.rs`). */
export const FAMILIES: { key: "space" | "channels" | "files" | "calendars"; permissions: string[] }[] = [
  {
    key: "space",
    permissions: [
      "space.settings", "members.view", "members.invite", "members.manage", "roles.manage", "groups.manage",
      "audit.view", "channels.create", "channels.delete", "calendars.create", "dm.start", "files.trash.purge",
    ],
  },
  {
    key: "channels",
    permissions: [
      "channel.view", "message.send", "message.react", "message.attach", "message.mention_all", "message.pin",
      "message.manage", "channel.members.manage", "channel.manage",
    ],
  },
  { key: "files", permissions: ["files.view", "files.create", "files.edit", "files.manage", "files.public_link"] },
  { key: "calendars", permissions: ["calendar.view", "calendar.write", "calendar.manage"] },
];

/** What a guest can never hold: the guests' base role does not offer them. */
export const GUEST_CEILING = new Set([
  "space.settings", "members.view", "members.invite", "members.manage", "roles.manage", "groups.manage",
  "audit.view", "channels.create", "channels.delete", "calendars.create", "files.trash.purge", "message.manage",
  "channel.members.manage", "channel.manage", "files.manage", "files.public_link", "calendar.manage",
]);

/** One row of the role editor. */
export function permissionRow(
  permission: string,
  ctx: { role: RoleLike; draft: Set<string>; viewerRights: string[]; membersBase: string[] },
): { on: boolean; locked: boolean; changed: boolean; givenByMembers: boolean } {
  const on = ctx.draft.has(permission);
  return {
    on,
    // Rule 2: what the viewer does not hold, they neither give nor take away.
    locked: !ctx.viewerRights.includes(permission),
    changed: on !== ctx.role.permissions.includes(permission),
    // Only a role of its own says so: @members is the base itself, and a guest never holds it.
    givenByMembers: !ctx.role.systemKey && ctx.membersBase.includes(permission),
  };
}

export function changedPermissions(before: string[], after: string[]): { added: string[]; removed: string[] } {
  return {
    added: after.filter((p) => !before.includes(p)),
    removed: before.filter((p) => !after.includes(p)),
  };
}

/**
 * Whether the viewer may set `wanted` (role ids, strongest first) as the order of `current` (the
 * roles above the base ones): every role once, and those the viewer cannot manage in place.
 */
export function orderAllowed(current: RoleLike[], wanted: string[]): boolean {
  if (wanted.length !== current.length || new Set(wanted).size !== wanted.length) return false;
  if (!current.every((r) => wanted.includes(r.id))) return false;
  return current.every((r, index) => r.manageable || wanted[index] === r.id);
}

/** What a member's "Gestion" tab (and the Members tab's dialog) offers the viewer. */
export type MemberAccess<R extends RoleLike = RoleLike> =
  | { mode: "none" }
  | { mode: "above" }
  | { mode: "frozen" }
  | { mode: "fixed" }
  /** Their roles read, not ticked: the viewer manages people, not roles. */
  | { mode: "held" }
  | { mode: "roles"; choices: RoleChoice<R>[] };

/**
 * One row of the roles checklist. `direct`: assigned to the person themselves. `via`: the names of
 * the groups that give it to them. Ticked when either; locked when it only comes through a group
 * (leaving the group is how it goes), or when the viewer may not give it.
 */
export type RoleChoice<R extends RoleLike = RoleLike> = { role: R; checked: boolean; disabled: boolean; direct: boolean; via: string[] };

export function memberAccessFor<R extends RoleLike>(input: {
  member: { userId: string; roleIds?: string[]; manageable?: boolean };
  me: string;
  edition: "community" | "enterprise" | "frozen";
  roles: R[];
  /** The viewer's rights in the space; absent reads as all of them (an older caller). */
  rights?: string[];
  /** The roles the person receives through groups, with the group names (`rolesViaGroups`). */
  viaGroups?: Map<string, string[]>;
}): MemberAccess<R> {
  if (input.member.userId === input.me) return { mode: "none" };
  if (!input.member.manageable) return { mode: "above" };
  if (input.edition === "frozen") return { mode: "frozen" };
  if (input.edition === "community") return { mode: "fixed" };
  if (input.rights && !input.rights.includes("roles.manage")) return { mode: "held" };
  const held = new Set(input.member.roleIds ?? []);
  return {
    mode: "roles",
    choices: input.roles
      .filter((r) => r.systemKey !== "members" && r.systemKey !== "guests")
      .map((role) => {
        const direct = held.has(role.id);
        const via = input.viaGroups?.get(role.id) ?? [];
        return { role, direct, via, checked: direct || via.length > 0, disabled: !role.manageable || (!direct && via.length > 0) };
      }),
  };
}

/**
 * The role ids a save sends (strongest first): the ticked ones the person holds directly or was
 * given here. A role that only comes through a group is never among them, whatever the draft says,
 * so saving cannot turn a group's role into a direct assignment.
 */
export function roleIdsToSave(roles: { id: string }[], choices: RoleChoice[], draft: Set<string>): string[] {
  const groupOnly = new Set(choices.filter((c) => !c.direct && c.via.length > 0).map((c) => c.role.id));
  return roles.filter((r) => draft.has(r.id) && !groupOnly.has(r.id)).map((r) => r.id);
}

/**
 * The legacy roles a membership can hold, weakest first: what a community space offers, and the
 * standing (guest or member) of anyone in a licensed one. The same order the API ranks them in,
 * mirrored to offer only what it would accept; the API refuses the rest whatever this says.
 */
export const LEGACY_ROLES = ["guest", "member", "admin", "owner"];

function legacyRank(role: string): number {
  return LEGACY_ROLES.indexOf(role) + 1;
}

/**
 * The legacy roles `mine` may give to someone holding `theirs`, or none when they may not touch that
 * membership. Only below one's own rank, and the owner may hand the space over, which costs them the
 * role in the same write.
 */
export function grantableRoles(mine: string, theirs: string): string[] {
  if (legacyRank(theirs) >= legacyRank(mine)) return [];
  const below = LEGACY_ROLES.filter((r) => legacyRank(r) < legacyRank(mine));
  return mine === "owner" ? [...below, "owner"] : below;
}

/**
 * What a row of the roles list does for the viewer: `edit` opens the editor (Administrator
 * included, for whoever sits above it: a system role is tuned, never deleted), the others say why
 * it does not open.
 */
export type RoleRowState = "edit" | "mine" | "above" | "frozen";

export function roleRowState(role: RoleLike, ctx: { myTopRoleId?: string; frozen: boolean }): RoleRowState {
  if (role.id === ctx.myTopRoleId) return "mine";
  if (!role.manageable) return "above";
  return ctx.frozen ? "frozen" : "edit";
}

/** Whether a role holds every right of the catalogue: said as such rather than counted. */
export function holdsEverything(role: Pick<RoleLike, "permissions">): boolean {
  return FAMILIES.every((f) => f.permissions.every((p) => role.permissions.includes(p)));
}
