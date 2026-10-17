/**
 * Who may do what in a space, and the member list's summary and search (`space/SpaceSettingsScreen`).
 *
 * The ranks mirror the API's, as the web's `WorkspaceSettings` does, for one reason: to offer only
 * what it would accept. They are the politeness, not the guard; the API refuses the rest.
 */
import { fold } from "./mentions.ts";

/** The roles a membership can hold, weakest first, in the API's order. */
export const ROLES = ["guest", "member", "admin", "owner"] as const;

/** Where a role sits in {@link ROLES}; an unknown one ranks lowest and can authorise nothing. */
function rank(role: string): number {
  return (ROLES as readonly string[]).indexOf(role) + 1;
}

/**
 * The roles `mine` may give to someone holding `theirs`, or none when that membership is out of
 * reach. One rule, the API's: only someone ranked below you, only a rank below your own; except the
 * owner, who may also hand the space over (and becomes an admin in the same write).
 */
export function grantableRoles(mine: string, theirs: string): string[] {
  if (rank(mine) === 0 || rank(theirs) >= rank(mine)) return [];
  const below = ROLES.filter((role) => rank(role) < rank(mine));
  return mine === "owner" ? [...below, "owner"] : below;
}

/** Invite, manage the members, choose the default channel: the owner and the admins. */
export function canAdminister(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** The space's name and icon: its owner alone, who holds it; an admin runs it. */
export function canEditIdentity(role: string | undefined): boolean {
  return role === "owner";
}

export function canDeleteSpace(role: string | undefined): boolean {
  return role === "owner";
}

/** "3 members, 1 external guest, 1 bot": people (guests included) and bots counted apart. */
export function memberCounts(members: { role: string; bot: boolean }[]): {
  people: number;
  guests: number;
  bots: number;
} {
  const bots = members.filter((m) => m.bot).length;
  const guests = members.filter((m) => !m.bot && m.role === "guest").length;
  return { people: members.length - bots, guests, bots };
}

/** The member search: part of the name, case and accents aside. */
export function matchesMember(member: { name: string }, query: string): boolean {
  return fold(member.name).includes(fold(query.trim()));
}

/** Deleting a space takes its name typed exactly (spaces around it aside), as on the web. */
export function nameConfirmed(typed: string, name: string): boolean {
  return typed.trim() !== "" && typed.trim() === name.trim();
}
