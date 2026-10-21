/**
 * The silent sync push (ADR 0006): a notification was read on another device, so the phone counts
 * its unread again for the icon and takes the read notifications off its screen. Free of the native
 * modules so Node tests it; `push/background.ts` does the asking and the dismissing.
 */

/** What a push handed to the app's background task is: a sync, a wake, or neither. */
export function pushKind(payload: unknown): "sync" | "wake" | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { actionIdentifier?: unknown; data?: Record<string, unknown>; aps?: Record<string, unknown> };
  // A tap on a notification (Android hands those to the task too): not a push.
  if (p.actionIdentifier !== undefined) return null;
  // iPhone: the relay's sync is the only push without an alert, carrying `content-available`.
  if (p.aps) return p.aps["content-available"] === 1 && !p.aps.alert ? "sync" : null;
  // Android: the data message says which. Anything but an explicit sync wakes, as every data message
  // did before the sync existed: a shape not recognised must never hide a new message.
  let said = p.data?.ruchoir;
  if (said === undefined && typeof p.data?.dataString === "string") {
    try {
      said = (JSON.parse(p.data.dataString) as { ruchoir?: unknown }).ruchoir;
    } catch {
      said = undefined;
    }
  }
  return said === "sync" ? "sync" : "wake";
}

/** A notification on the phone's screen: its system identifier, and its instance and id when known. */
export type Shown = { identifier: string; server?: string; notificationId?: string };

/** What an instance answered: its unread notification ids, and whether that is all of them. */
export type Unread = { unread: Set<string>; complete: boolean };

/**
 * The notifications to take off the screen: those read on their instance. One whose instance did not
 * answer stays; so does one the unread list may not have reached (more unread than one page). One
 * that does not say where it comes from ("New activity", or drawn by an older version) goes only
 * when every instance answered and nothing at all is unread.
 */
export function toDismiss(shown: Shown[], answers: Map<string, Unread>, nothingUnread: boolean): string[] {
  return shown
    .filter(({ server, notificationId }) => {
      if (!server || !notificationId) return nothingUnread;
      const answer = answers.get(server);
      if (!answer) return false;
      return !answer.unread.has(notificationId) && (answer.complete || answer.unread.size === 0);
    })
    .map((s) => s.identifier);
}
