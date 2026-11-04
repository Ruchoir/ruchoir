/**
 * "Voir en tant que" on the phone, without drawing anything: whether the app may write on its own,
 * what the banner says, when a preview has ended, and the refused-write toast that speaks once. The
 * shared logic (`@ruchoir/client/permissionsLogic`) decides the words; this keeps the phone's pieces
 * testable.
 */
import { bannerOf, previewGone, previewToast } from "@ruchoir/client/permissionsLogic";

type PreviewLike = { roleId: string; roleName: string; idleSeconds?: number };
type SpaceLike = { id: string; preview?: PreviewLike };

/**
 * Whether the app may write on its own account (read cursors, "is writing", notification reads, an
 * editor's heartbeat, the push token): never while the space is looked at as a role. The client holds
 * the same line for every request (`previewActive`); this is for the code that decides before asking.
 */
export function backgroundWritesAllowed(space: { preview?: unknown } | null | undefined): boolean {
  return !space?.preview;
}

/** The banner's two lines: who is looked at, and the minutes without activity after which it ends. */
export function bannerWords(preview: PreviewLike, spaceName: string): { space: string; role: string; minutes: number } {
  return bannerOf(preview, spaceName);
}

/** Whether the preview this phone showed (`previousRoleId`) is over: the space no longer carries it. */
export function previewEnded(previousRoleId: string | undefined, space: SpaceLike | null): boolean {
  if (!previousRoleId || !space) return false;
  return previewGone(previousRoleId, [space], space.id);
}

/** The dictionary key of the sentence a refused write says (the title: the first line of the toast). */
export function refusedSentence(request?: { method: string; path: string }): string {
  return previewToast(request).titleKey;
}

/** The dictionary key of the toast's second line: what happened to the person's change or message. */
export function refusedBody(request?: { method: string; path: string }): string {
  return previewToast(request).bodyKey;
}

/**
 * What the phone remembers of the preview it showed (the space and the role), against the space it
 * shows now. A preview belongs to the session, whatever the space: when the space on screen is no
 * longer the one that was previewed, the preview of the previous one is quit (`quitSpaceId`), and
 * nothing is announced as ended: the person changed space, the preview did not run out. Only the
 * same space coming back without its role is an end.
 */
export function previewTransition(
  seen: { spaceId: string; roleId: string | undefined } | undefined,
  current: SpaceLike | null,
): { quitSpaceId?: string; ended: boolean } {
  if (!seen?.roleId || !current) return { ended: false };
  if (seen.spaceId !== current.id) return { quitSpaceId: seen.spaceId, ended: false };
  return { ended: previewEnded(seen.roleId, current) };
}

const DEFAULT_IDLE_SECONDS = 1800;

/** How long a preview lasts without a touch, in milliseconds: what the space says, else 30 minutes. */
export function idleMs(idleSeconds: number | undefined): number {
  return (idleSeconds && idleSeconds > 0 ? idleSeconds : DEFAULT_IDLE_SECONDS) * 1000;
}

/** Whether nobody touched the phone for as long as the preview lasts (the server ends it then too). */
export function idleExpired(lastTouchAt: number, now: number, idleSeconds: number | undefined): boolean {
  return now - lastTouchAt >= idleMs(idleSeconds);
}

/**
 * The status bar's height a screen under the preview banner must keep clear of: none, the banner
 * already covers it (reading the window's inset there would leave a double gap).
 */
export function topInsetUnderBanner(top: number, previewing: boolean): number {
  return previewing ? 0 : top;
}

/** How long a failure toast that follows a refused write is taken for that write's own echo. */
const ECHO_MS = 400;

/**
 * Which toasts speak. A write the preview refused says its sentence once (two refusals of one
 * attempt are one toast), and the failure toast the screen raises for that very call, a few
 * milliseconds later ("Message non envoyé"), is dropped once: it would replace the preview's
 * sentence with a worse one. Any other failure toast, later or a second one, is shown.
 */
export function refusalGate(): { allows: (now: number, toast: { failure: boolean; preview: boolean }) => boolean } {
  let spokeAt: number | undefined;
  return {
    allows: (now, toast) => {
      const recent = spokeAt !== undefined && now - spokeAt < ECHO_MS;
      if (toast.preview) {
        if (recent) return false;
        spokeAt = now;
        return true;
      }
      if (toast.failure && recent) {
        spokeAt = undefined;
        return false;
      }
      return true;
    },
  };
}
