/**
 * What a role's editor decides without drawing anything: how many changes wait to be saved, what
 * goes to the server, the rows of each family with their lock, and what the role offers (its tabs,
 * Supprimer, Voir en tant que). The API is the judge; this keeps the screen from offering what it
 * would refuse, and says why.
 */
import {
  FAMILIES,
  GUEST_CEILING_SET,
  changedPermissions,
  permissionRow,
  usedInRows,
  viewAsState,
  type Edition,
  type UsedInRow,
} from "@ruchoir/client/permissionsLogic";

type RoleLike = {
  id: string;
  name: string;
  colour?: string;
  permissions: string[];
  manageable: boolean;
  systemKey?: "administrator" | "members" | "guests";
};

/** What is being edited: the name, the colour and the rights as they stand on screen. */
export type RoleDraft = { name: string; colour: string; permissions: Set<string> };

/** The pastels the server accepts (`ROLE_COLOURS` in `apps/api/src/permissions/roles.rs`). */
export const COLOUR_CHOICES = ["sky", "mint", "violet", "pink", "peach", "lime", "sun"] as const;

/** The colour a role shows when it has none set. */
export const DEFAULT_COLOUR = "sky";

export function draftFrom(role: RoleLike): RoleDraft {
  return { name: role.name, colour: role.colour ?? DEFAULT_COLOUR, permissions: new Set(role.permissions) };
}

const CATALOGUE = FAMILIES.flatMap((f) => f.permissions);

/** What is saved of a role, as one string: a draft started before it changed under it starts over. */
export function roleSignature(role: RoleLike): string {
  return `${role.name}|${role.colour ?? ""}|${role.permissions.join(",")}`;
}

/**
 * The draft on screen: the person's own while the role is as it was when they started (and after a
 * save, until the reloaded role arrives, so the screen does not flicker back to the old values),
 * else the role as saved.
 */
export function editorDraft(edit: { base: string; draft: RoleDraft } | null, role: RoleLike): RoleDraft {
  return edit && edit.base === roleSignature(role) ? edit.draft : draftFrom(role);
}

/** Why the draft cannot be saved as it stands, if it cannot: an empty name. */
export function saveBlock(draft: RoleDraft): "nameRequired" | null {
  return draft.name.trim() ? null : "nameRequired";
}

/** The colour a new role starts with: the one of the role it copies, else mint (as the web). */
export function newRoleColour(roles: { id: string; colour?: string }[], copyFrom: string | null): string {
  if (!copyFrom) return "mint";
  const source = roles.find((r) => r.id === copyFrom);
  return source ? (source.colour ?? DEFAULT_COLOUR) : "mint";
}

/**
 * Changes waiting to be saved: the name, the colour, and each right added or taken away. An empty
 * name is not one: the save cannot send it (`saveBlock` says why).
 */
export function changeCount(role: RoleLike, draft: RoleDraft): number {
  const { added, removed } = changedPermissions(role.permissions, CATALOGUE.filter((p) => draft.permissions.has(p)));
  const name = draft.name.trim();
  const named = name && name !== role.name ? 1 : 0;
  const coloured = draft.colour !== (role.colour ?? DEFAULT_COLOUR) ? 1 : 0;
  return named + coloured + added.length + removed.length;
}

/** What `updateRole` gets: only what changed. `null` when the name is empty (`saveBlock`). */
export function savePayload(role: RoleLike, draft: RoleDraft): { name?: string; colour?: string; permissions?: string[] } | null {
  const name = draft.name.trim();
  if (!name) return null;
  const out: { name?: string; colour?: string; permissions?: string[] } = {};
  if (name !== role.name) out.name = name;
  if (draft.colour !== (role.colour ?? DEFAULT_COLOUR)) out.colour = draft.colour;
  const after = CATALOGUE.filter((p) => draft.permissions.has(p));
  const { added, removed } = changedPermissions(role.permissions, after);
  if (added.length + removed.length > 0) out.permissions = after;
  return out;
}

/** Why a row cannot be switched: a right the caller does not hold, or one no guest can ever have. */
export type RowLock = "notHeld" | "ceiling" | null;

export type EditorRow = { permission: string; on: boolean; changed: boolean; givenByMembers: boolean; lock: RowLock };

export function familyRows(
  role: RoleLike,
  draft: RoleDraft,
  ctx: { viewerRights: string[]; membersBase: string[] },
): { key: (typeof FAMILIES)[number]["key"]; rows: EditorRow[] }[] {
  return FAMILIES.map((family) => ({
    key: family.key,
    rows: family.permissions.map((permission) => {
      const row = permissionRow(permission, { role, draft: draft.permissions, viewerRights: ctx.viewerRights, membersBase: ctx.membersBase });
      const ceiling = role.systemKey === "guests" && GUEST_CEILING_SET.has(permission);
      return {
        permission,
        on: row.on,
        changed: row.changed,
        givenByMembers: row.givenByMembers,
        lock: ceiling ? "ceiling" : row.locked ? "notHeld" : null,
      };
    }),
  }));
}

export type EditorTab = "rights" | "people" | "name";

/** What a role offers the viewer, as the web's editor decides it. */
export function editorAccess(
  role: RoleLike,
  ctx: { edition: Edition; canManageRoles: boolean; frozen: boolean },
): { tabs: EditorTab[]; editable: boolean; canDelete: boolean; canPreview: boolean } {
  const custom = !role.systemKey;
  const editable = role.manageable && !ctx.frozen;
  return {
    tabs: ["rights", ...(role.systemKey === "members" ? [] : ["people" as const]), ...(custom ? ["name" as const] : [])],
    editable,
    canDelete: custom && editable,
    canPreview: viewAsState(role, { edition: ctx.edition, canManageRoles: ctx.canManageRoles }) === "button",
  };
}

/** The places a refused deletion lists, ready to draw. */
export function usedInRowsOf(used: Parameters<typeof usedInRows>[0]): UsedInRow[] {
  return usedInRows(used);
}

/**
 * A person's role ids with this one added or taken out, strongest first (the order the server keeps):
 * `ranked` is the space's roles above the base ones, strongest first.
 */
export function rolesWith(held: string[] | undefined, ranked: { id: string }[], roleId: string, on: boolean): string[] {
  const set = new Set(held ?? []);
  if (on) set.add(roleId);
  else set.delete(roleId);
  return ranked.filter((r) => set.has(r.id)).map((r) => r.id);
}
