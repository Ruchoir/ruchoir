/**
 * "Voir en tant que" on the phone, without drawing anything: whether the app may write on its own,
 * what the banner says, when a preview has ended, and the refused-write toast that speaks once. The
 * shared logic (`@ruchoir/client/permissionsLogic`) decides the words; this keeps the phone's pieces
 * testable.
 */
import { bannerOf, previewGone, previewToast, shouldShowToast } from "@ruchoir/client/permissionsLogic";

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

/** The dictionary key of the sentence a refused write says (the title: a toast is one line). */
export function refusedSentence(request?: { method: string; path: string }): string {
  return previewToast(request).titleKey;
}

/**
 * The failure toast a screen raises right after a refused write ("Message non envoyé") would replace
 * the preview's own sentence with a worse one: for a moment only the preview's toast gets through.
 */
export function refusalGate(): { refused: (now: number) => void; allows: (now: number, toast: { failure: boolean; preview: boolean }) => boolean } {
  let at: number | undefined;
  return {
    refused: (now) => {
      at = now;
    },
    allows: (now, toast) => shouldShowToast(at, now, { tone: toast.failure ? "danger" : "success", isPreviewToast: toast.preview }),
  };
}
