/**
 * What the members list and a member's screen decide, without drawing anything: the filter counts,
 * how a row reads, which role toggles are off and why, what the save bar counts, and the short dates
 * of a guest's end and of an ended access. The sentences are dictionary keys the screens translate;
 * the rights themselves come from `@ruchoir/client/permissionsLogic`, shared with the web.
 */
import { keepLabel, rolesViaGroups, type RoleChoice } from "@ruchoir/client/permissionsLogic";
import type { EndedAccess } from "@ruchoir/client";

/** Parts of a date are read in a fixed numeric format and never shown: any locale that writes digits the same way will do. */
const PARTS_LOCALE = "en-CA";

/** The three filters of the list, in the order of the chips. */
export type PeopleFilter = "all" | "members" | "guests";

/** How many each filter lists: Tous is everyone, bots too; Membres and Invités are people only, so each count is the length of its list. */
export function filterCounts(people: { role: string; bot?: boolean }[]): Record<PeopleFilter, number> {
  return { all: people.length, members: filterPeople(people, "members").length, guests: filterPeople(people, "guests").length };
}

export function filterPeople<T extends { role: string; bot?: boolean }>(people: T[], filter: PeopleFilter): T[] {
  if (filter === "all") return people;
  return people.filter((p) => !p.bot && (p.role === "guest") === (filter === "guests"));
}

/**
 * What the end of a row offers: a chevron (`open`), a lock (`locked`: oneself, or above the caller),
 * nothing (a bot, or a viewer who may see people without managing them: the web gives them no way in
 * and no reason to be told what is above them).
 */
export function rowAccess(member: { userId: string; bot: boolean; manageable?: boolean }, me: string | undefined, viewerManages: boolean): "open" | "locked" | "none" {
  if (member.bot || !viewerManages) return "none";
  if (member.userId === me || !member.manageable) return "locked";
  return "open";
}

type RoleView = { id: string; systemKey?: "administrator" | "members" | "guests"; colour?: string };

/** The phone's own time zone, read when needed: a guest's end is the end of a day where the person setting it is. */
export function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A day picked on the phone's calendar as `YYYY-MM-DD`, read in the phone's own zone (what the shared date logic takes). */
export function pickedDay(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/**
 * A day picked on a native date picker, or null when the person did not pick one: Android's dialog
 * also reports "dismissed" (cancel, back) with a date in hand, which must not set anything.
 */
export function pickedFromEvent(event: { type?: string }, date: Date | undefined): string | null {
  return event.type === "set" && date ? pickedDay(date) : null;
}

/** "Lui transmettre l'espace": the owner offers it for anyone but themselves and a bot, a guest included (the web's rule). */
export function offersHandOver(viewerRole: string, member: { role: string; bot?: boolean }): boolean {
  return viewerRole === "owner" && member.role !== "owner" && !member.bot;
}

/** The role draft being edited, while it still starts from what is saved; null once the saved roles moved on (or after a save, when they do). */
export function liveDraft(edit: { base: string; set: Set<string> } | null, saved: string): Set<string> | null {
  return edit && edit.base === saved ? edit.set : null;
}

/**
 * What a member's screen shows: the space it was opened in may not be the current one yet (a notice
 * or a link selects it and navigates at once), so the list of another space proves nothing.
 */
export function memberStatus(o: { spaceId?: string; currentId: string; listed: boolean; found: boolean }): "loading" | "gone" | "ready" {
  if ((o.spaceId && o.spaceId !== o.currentId) || !o.listed) return "loading";
  return o.found ? "ready" : "gone";
}

/** The dictionary key naming a system role (Administrator, @members, @guests), or null for a role named by hand. */
export function systemRoleKey(role: Pick<RoleView, "systemKey">): "role.admin" | "roles.everyone" | "roles.guests" | null {
  if (role.systemKey === "administrator") return "role.admin";
  if (role.systemKey === "members") return "roles.everyone";
  if (role.systemKey === "guests") return "roles.guests";
  return null;
}

/** The pastel names the server knows (`ROLE_COLOURS`), the ones the theme's palette carries too. */
const PASTELS = ["sky", "mint", "violet", "pink", "peach", "lime", "sun"] as const;
export type RoleColour = (typeof PASTELS)[number] | "line";

/** A role's dot: Administrator is peach, a named pastel is itself, the base roles a neutral line. */
export function roleColourKey(role: Pick<RoleView, "colour" | "systemKey">): RoleColour {
  if (role.systemKey === "administrator") return "peach";
  return (PASTELS as readonly string[]).includes(role.colour ?? "") ? (role.colour as RoleColour) : "line";
}

/** The roles someone holds in the space's order, given to them or through a group (`via` names those groups). */
export function heldRoles<R extends RoleView>(
  member: { userId: string; roleIds?: string[] },
  roles: R[],
  groups: Parameters<typeof rolesViaGroups>[1],
): { role: R; via: string[] }[] {
  const direct = new Set(member.roleIds ?? []);
  const viaMap = rolesViaGroups(member, groups);
  return roles
    .filter((r) => direct.has(r.id) || viaMap.has(r.id))
    .map((role) => ({ role, via: direct.has(role.id) ? [] : (viaMap.get(role.id) ?? []) }));
}

/** The draft a role editor starts from: what the person holds directly. */
export function draftOf(choices: RoleChoice[]): Set<string> {
  return new Set(choices.filter((c) => c.direct).map((c) => c.role.id));
}

/** "1 changement": the roles that differ between what is saved and what the toggles say. */
export function changeCount(initial: Iterable<string>, draft: Iterable<string>): number {
  const before = new Set(initial);
  const after = new Set(draft);
  let n = 0;
  for (const id of before) if (!after.has(id)) n += 1;
  for (const id of after) if (!before.has(id)) n += 1;
  return n;
}

/** The sentence under a toggle: a dictionary key, and the groups it names. */
export type ToggleReason =
  | { key: "groups.viaReason" | "groups.alsoDirect"; via: string[] }
  | { key: "roles.aboveYou" | "roles.yourTopRole" };

export type ToggleRow = {
  roleId: string;
  on: boolean;
  disabled: boolean;
  /** Differs from what is saved: highlighted until saved. */
  changed: boolean;
  /** Only a group gives it: shown on, never edited here. */
  groupOnly: boolean;
  reason: ToggleReason | null;
};

/** One row per role the caller may see, as the web's checklist words them. */
export function toggleRows(choices: RoleChoice[], draft: Set<string>, ctx: { myTopRoleId?: string }): ToggleRow[] {
  const initial = draftOf(choices);
  return choices.map(({ role, disabled, direct, via }) => {
    const groupOnly = !direct && via.length > 0;
    const reason: ToggleReason | null = groupOnly
      ? { key: "groups.viaReason", via }
      : disabled
        ? { key: role.id === ctx.myTopRoleId ? "roles.yourTopRole" : "roles.aboveYou" }
        : via.length > 0
          ? { key: "groups.alsoDirect", via }
          : null;
    return {
      roleId: role.id,
      on: draft.has(role.id) || groupOnly,
      disabled,
      changed: !groupOnly && draft.has(role.id) !== initial.has(role.id),
      groupOnly,
      reason,
    };
  });
}

/** "7 nov.": the day an instant falls on in `zone`, with the year when it is not the current one. */
export function shortDay(iso: string, locale: string, zone: string, now: Date): string {
  const at = new Date(iso);
  const year = (d: Date) => new Intl.DateTimeFormat(PARTS_LOCALE, { year: "numeric", timeZone: zone }).format(d);
  const opts: Intl.DateTimeFormatOptions = year(at) === year(now) ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" };
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: zone }).format(at);
}

/** The pieces of an ended access's row: who, the day it ended and how long ago. */
export function endedRowText(item: EndedAccess, now: Date, locale: string, zone: string) {
  return {
    name: item.name,
    title: item.title,
    endedOn: shortDay(item.endedAt, locale, zone, now),
    ago: keepLabel(item.endedAt, now, locale),
  };
}
