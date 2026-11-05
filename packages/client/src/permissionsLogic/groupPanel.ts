/**
 * What the group panel decides without drawing anything: whether the viewer gets the "Gestion" tab,
 * who they may remove, and which groups a guest may mention. The API judges every write; this only
 * keeps the panel from offering what it will refuse, and says why where a row is locked.
 */
import { groupMentionHits, type GroupLike } from "./groups.ts";

/** A group as the panel reads it: `Group` from the client, the fields used here. */
export type PanelGroup = GroupLike & {
  may: { changeMembers: boolean; appoint: boolean };
};

/** Whether the viewer is one of the group's managers. */
export function isManagerOf(group: Pick<PanelGroup, "managerIds">, viewerId: string): boolean {
  return group.managerIds.includes(viewerId);
}

/**
 * The "Gestion" tab: for whoever the server lets change this group's members (`may.changeMembers`
 * already covers its managers, whoever may do it space-wide, and the licence). Never for a group
 * mirrored from a directory, whose people are changed there.
 */
export function offersManagement(group: PanelGroup): boolean {
  return group.source !== "directory" && group.may.changeMembers;
}

/** Whether "Quitter le groupe" is offered: to a member, never for a directory group. */
export function offersLeaving(group: Pick<PanelGroup, "source" | "memberIds">, viewerId: string): boolean {
  return group.source !== "directory" && group.memberIds.includes(viewerId);
}

export type Removal =
  | { removable: true }
  | { removable: false; reason: "self" | "manager_protected" | "directory" | "forbidden" };

/**
 * Whether one person of the group can be taken out by the viewer. The viewer's own row is left to
 * "Quitter le groupe". Nothing is offered where the server would not let the viewer change members
 * (`forbidden`: a frozen licence, no right). A manager cannot remove another manager unless they may
 * appoint (the server's `manager_protected`); someone who changes members without managing the group
 * is not held by it.
 */
export function removalOf(group: PanelGroup, viewerId: string, personId: string): Removal {
  if (group.source === "directory") return { removable: false, reason: "directory" };
  if (personId === viewerId) return { removable: false, reason: "self" };
  if (!group.may.changeMembers) return { removable: false, reason: "forbidden" };
  if (group.managerIds.includes(personId) && isManagerOf(group, viewerId) && !group.may.appoint) {
    return { removable: false, reason: "manager_protected" };
  }
  return { removable: true };
}

/**
 * Why someone cannot be ticked in the add dialog: nobody gives themselves a role through a group
 * (the server's `no_self_role`), unless they own the space.
 */
export function addBlockFor(
  ctx: { carriesRoles: boolean; viewerId: string; viewerIsOwner: boolean },
  personId: string,
): "self_role" | null {
  return ctx.carriesRoles && !ctx.viewerIsOwner && personId === ctx.viewerId ? "self_role" : null;
}

/** Whether the add notice owes a line about guests: one is ticked and the group carries roles. */
export function guestCeilingApplies(people: { userId: string; role?: string }[], picked: Set<string>, carriesRoles: boolean): boolean {
  return carriesRoles && people.some((m) => picked.has(m.userId) && m.role === "guest");
}

/** The groups a typed mention offers: none for a guest, who cannot mention a group. */
export function groupHitsFor<G extends GroupLike>(
  viewerRole: string | undefined,
  groups: G[],
  query: string,
  audienceIds: string[],
): { group: G; members: number; inRoom: number }[] {
  if (viewerRole === "guest") return [];
  return groupMentionHits(groups, query, audienceIds);
}

/** Why an addition is refused: the space is on the free edition, or its licence has expired. */
export type AdditionLock = "licence_required" | "licence_frozen";

/**
 * Whether additions to a group are paid for here, from the group's `may.addNeedsLicence`: taking a
 * role, a manager or a person away stays free in a free or frozen space, adding does not.
 */
export function additionLock(edition: "community" | "enterprise" | "frozen", addNeedsLicence: boolean): AdditionLock | null {
  if (!addNeedsLicence) return null;
  return edition === "frozen" ? "licence_frozen" : "licence_required";
}

/** The dictionary key of the sentence that says why (the role editor's own lines). */
export function additionLockKey(lock: AdditionLock): "roles.refusal.licenceRequired" | "roles.refusal.licenceFrozen" {
  return lock === "licence_frozen" ? "roles.refusal.licenceFrozen" : "roles.refusal.licenceRequired";
}

/** A role the group already carries can always be switched off (and on again); a new one waits for a licence. */
export function roleToggleLock(group: Pick<GroupLike, "roleIds">, roleId: string, lock: AdditionLock | null): AdditionLock | null {
  return group.roleIds.includes(roleId) ? null : lock;
}

/** A manager can always be taken off; naming one waits for a licence. */
export function appointLock(group: Pick<GroupLike, "managerIds">, personId: string, lock: AdditionLock | null): AdditionLock | null {
  return group.managerIds.includes(personId) ? null : lock;
}

/** Putting people in a group is paid when the server says so (`may.addPeopleNeedsLicence`): the group carries roles, or the caller acts as its manager only. */
export function addPeopleLock(edition: "community" | "enterprise" | "frozen", addPeopleNeedsLicence: boolean): AdditionLock | null {
  return additionLock(edition, addPeopleNeedsLicence);
}
