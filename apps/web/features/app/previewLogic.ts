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
  // The three system roles are base roles: the API answers `base_role_not_previewable` for them.
  if (role.systemKey) return "hidden";
  return ctx.edition === "community" ? "locked" : "button";
}

/** The banner's words: the space, the role, and the minutes of silence after which it ends. */
export function bannerOf(preview: { roleName: string; idleSeconds?: number }, spaceName: string): { space: string; role: string; minutes: number } {
  return { space: spaceName, role: preview.roleName, minutes: Math.round((preview.idleSeconds ?? 1800) / 60) };
}

/** The toast of a write the server refused during a preview (frame 14); the keys are dictionary keys. */
export function previewToast(request?: { method: string; path: string }): {
  tone: "danger";
  titleKey: "preview.readOnlyTitle";
  bodyKey: "preview.readOnlyBody" | "preview.readOnlyBodySend";
} {
  // A message posted to a channel, a thread or a conversation says "your message"; anything else is generic.
  const sending = request?.method === "POST" && /\/messages$/.test(request.path);
  return { tone: "danger", titleKey: "preview.readOnlyTitle", bodyKey: sending ? "preview.readOnlyBodySend" : "preview.readOnlyBody" };
}

/**
 * Whether the preview this screen shows has ended on the server (30 minutes without activity, or
 * quit from another window): the fresh list of spaces no longer says the same role. A space missing
 * from the answer proves nothing.
 */
export function previewGone(
  localRoleId: string | undefined,
  fresh: { id: string; preview?: { roleId: string } }[],
  spaceId: string,
): boolean {
  if (!localRoleId) return false;
  const space = fresh.find((w) => w.id === spaceId);
  return space !== undefined && space.preview?.roleId !== localRoleId;
}

/** A refusal the global preview toast already said: the screen's own failure toast stays quiet. */
export function shouldToastRefusal(refusal: { code: string } | undefined): boolean {
  return refusal?.code !== "preview_read_only";
}

/**
 * Whether a toast may be shown. A write refused by a preview is already told once, by the app; the
 * failure toast the screen raises right after ("Message non envoye") would replace it with a worse
 * explanation, so for a short moment only the preview's own toast gets through among failures.
 */
export function shouldShowToast(
  previewRefusedAt: number | undefined,
  now: number,
  toast: { tone: string; isPreviewToast: boolean },
): boolean {
  // Failures come as danger, or as info for a message that was not sent: both are the same refusal.
  if (previewRefusedAt === undefined || toast.tone === "success" || toast.isPreviewToast) return true;
  return now - previewRefusedAt > 1500;
}
