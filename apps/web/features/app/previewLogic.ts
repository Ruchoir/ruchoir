/**
 * "Voir en tant que" without drawing anything: who is offered the button, what the black banner
 * says, and the toast of a refused write. The API is the judge (roles strictly below the viewer, 402
 * in a free space, every write refused during a preview); this offers what it would accept.
 */

export type Edition = "community" | "enterprise" | "frozen";

/**
 * What a role row offers: `button` (look at the space as this role), `locked` (a free space: the
 * feature is Entreprise, said once), `hidden` (nothing to say). Only for a viewer who manages roles
 * and a custom role strictly below theirs (`manageable`); the base roles cannot be previewed. A
 * frozen space still previews: it is read only anyway.
 */
export function viewAsState(
  role: { systemKey?: "administrator" | "members" | "guests"; manageable: boolean },
  ctx: { edition: Edition; canManageRoles: boolean },
): "button" | "locked" | "hidden" {
  if (!ctx.canManageRoles || !role.manageable) return "hidden";
  if (role.systemKey === "members" || role.systemKey === "guests") return "hidden";
  return ctx.edition === "community" ? "locked" : "button";
}

/** The banner's words: the space, the role, and the minutes of silence after which it ends. */
export function bannerOf(preview: { roleName: string; idleSeconds?: number }, spaceName: string): { space: string; role: string; minutes: number } {
  return { space: spaceName, role: preview.roleName, minutes: Math.round((preview.idleSeconds ?? 1800) / 60) };
}

/** The toast of a write the server refused during a preview (frame 14); the keys are dictionary keys. */
export function previewToast(): { tone: "danger"; titleKey: "preview.readOnlyTitle"; bodyKey: "preview.readOnlyBody" } {
  return { tone: "danger", titleKey: "preview.readOnlyTitle", bodyKey: "preview.readOnlyBody" };
}
