/**
 * What the groups screens decide without drawing anything: which actions a group and each of its
 * people offer (each by the `may` block the API sends, as the web's editor reads it), the line under
 * a group in the list, who can be picked to join, and the role toggles with their locks. The API is
 * the judge of every write; this keeps the phone from offering what it would refuse. Pure, tested by Node.
 */
import { addBlockFor, addPeopleLock, additionLock, appointLock, groupRow, offersManagement, removalOf, roleToggleLock, type AdditionLock, type PanelGroup } from "@ruchoir/client/permissionsLogic";

import { rolesWith } from "./roleEditor.ts";

type Ctx = { licensed: boolean; frozen: boolean };

type GroupView = PanelGroup & { may: PanelGroup["may"] & { edit: boolean; delete: boolean; changeRoles: boolean; addNeedsLicence: boolean; addPeopleNeedsLicence: boolean } };

type RoleView = { id: string; name: string; permissions: string[]; manageable: boolean; systemKey?: "administrator" | "members" | "guests" };

/** Whether additions are paid for here (a free or frozen space), and so which sentence says why. Taking away is never locked. */
export function lockOf(group: Pick<GroupView, "may">, ctx: Ctx): AdditionLock | null {
  return additionLock(editionOf(ctx), group.may.addNeedsLicence);
}

function editionOf(ctx: Ctx): "community" | "enterprise" | "frozen" {
  return ctx.frozen ? "frozen" : ctx.licensed ? "enterprise" : "community";
}

/** What a group offers the viewer as a whole. `roles` and `managers` say whether those blocks are drawn at all. */
export function groupAbilities(group: GroupView, ctx: Ctx) {
  const directory = group.source === "directory";
  return {
    add: offersManagement(group),
    // Why adding people is off: the server says the licence refuses it (roles carried, or manager-only).
    addLock: addPeopleLock(editionOf(ctx), group.may.addPeopleNeedsLicence),
    rename: group.may.edit,
    delete: group.may.delete,
    // The roles and managers blocks exist on the licensed editions, and elsewhere while the group still holds some to take away; a directory group has no manager.
    roles: ctx.licensed || group.roleIds.length > 0,
    rolesEditable: group.may.changeRoles,
    managers: (ctx.licensed || group.managerIds.length > 0) && !directory,
    // Why naming a manager is off.
    appointLock: lockOf(group, ctx),
  };
}

export type PersonAction = "remove" | "appoint" | "unappoint";

/** The entries of a person's menu in the group, in the order they are shown. Empty: no menu at all. */
export function personActions(
  group: GroupView,
  ctx: Ctx & { viewerId: string },
  person: { userId: string; role?: string },
): PersonAction[] {
  if (group.source === "directory") return [];
  const out: PersonAction[] = [];
  if (removalOf(group, ctx.viewerId, person.userId).removable) out.push("remove");
  // A manager can always be taken off; naming one waits for a licence.
  if (group.may.appoint && (ctx.licensed || group.managerIds.includes(person.userId)) && person.role !== "guest" && appointLock(group, person.userId, lockOf(group, ctx)) === null) {
    out.push(group.managerIds.includes(person.userId) ? "unappoint" : "appoint");
  }
  return out;
}

/** One piece of a line: a dictionary key and its variables. The screen joins the pieces with " · ". */
export type LinePart = { key: string; vars?: Record<string, number | string> };

/** The line under a group of the list: how many people, and the roles it carries (licensed editions only). */
export function rowLine(people: number, carried: string[], licensed: boolean): LinePart[] {
  const count: LinePart = { key: "conversation.people", vars: { count: people } };
  if (!licensed) return [count];
  return [count, carried.length > 0 ? { key: "groups.carries", vars: { roles: carried.join(", ") } } : { key: "groups.noRoleLine" }];
}

/** Whether a row of the list opens: not when it carries a role above the viewer's and nothing is theirs to change (the web's rule). */
export function groupOpens(group: Pick<GroupView, "may">, locked: ReturnType<typeof groupRow>["locked"]): boolean {
  return locked !== "above" || Object.entries(group.may).some(([key, allowed]) => !key.startsWith("add") && allowed);
}

/** The people who can be picked to join: not bots, not already in, and not oneself in a group that carries roles (unless owner). */
export function pickablePeople<M extends { userId: string; bot?: boolean }>(
  members: M[],
  group: Pick<GroupView, "memberIds">,
  ctx: { carriesRoles: boolean; viewerId: string; viewerIsOwner: boolean },
): M[] {
  return members.filter((m) => !m.bot && !group.memberIds.includes(m.userId) && addBlockFor(ctx, m.userId) === null);
}

export type RoleToggle = { role: RoleView; on: boolean; lock: "above" | "yourTop" | null; licenceLock: AdditionLock | null; enabled: boolean };

/** The base roles are everyone's and are never carried by a group; the others toggle, those above the viewer locked with the reason. */
export function roleToggleRows(group: Pick<GroupView, "roleIds">, roles: RoleView[], ctx: { myTopRoleId: string | undefined; editable: boolean; additions?: AdditionLock | null }): RoleToggle[] {
  return roles
    .filter((r) => r.systemKey !== "members" && r.systemKey !== "guests")
    .map((role) => {
      // A role the group carries stays switchable off; a new one waits for a licence.
      const licenceLock = roleToggleLock(group, role.id, ctx.additions ?? null);
      return {
        role,
        on: group.roleIds.includes(role.id),
        lock: role.manageable ? null : role.id === ctx.myTopRoleId ? "yourTop" : "above",
        licenceLock,
        enabled: ctx.editable && role.manageable && licenceLock === null,
      } satisfies RoleToggle;
    });
}

/** What `setGroupRoles` gets after one toggle: the whole list, strongest first, locked roles kept as they are. */
export function togglePayload(group: Pick<GroupView, "roleIds">, roles: RoleView[], roleId: string, on: boolean): string[] {
  const ranked = roles.filter((r) => r.systemKey !== "members" && r.systemKey !== "guests");
  return rolesWith(group.roleIds, ranked, roleId, on);
}

/**
 * The roles the toggles keep showing while a save is on its way: `pending` until the reloaded group
 * carries the same roles (any order), then null, so a switch never springs back and forth.
 */
export function settledRoles(pending: string[] | null, actual: string[]): string[] | null {
  if (!pending) return null;
  const same = pending.length === actual.length && pending.every((id) => actual.includes(id));
  return same ? null : pending;
}

export { groupColour } from "@ruchoir/client/permissionsLogic";
