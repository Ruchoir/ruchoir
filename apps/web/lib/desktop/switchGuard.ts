/**
 * Switching instance while files are being sent (ADR 0008, step 2).
 *
 * The files queue (`lib/uploads.ts`) is app-wide and reads the client's address when each file
 * starts, so a file still queued would start on the next instance. Switching therefore asks first:
 * wait (nothing happens), or cancel the sends and switch.
 */
export async function guardedSwitch(
  isBusy: () => boolean,
  ask: () => Promise<"wait" | "cancel">,
  cancelAll: () => void,
  go: () => void,
): Promise<boolean> {
  if (isBusy()) {
    if ((await ask()) === "wait") return false;
    cancelAll();
  }
  go();
  return true;
}
