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

/**
 * What to do once the interface is asked to show `target` while `current` is open: within the same
 * instance, mount a fresh interface at the new address; for another instance, nothing yet, since the
 * interface remounts itself (its key) when the core says the open instance changed, and reads the
 * address then. Remounting at once would show the old instance at the new instance's address.
 */
export function afterOpen(current: string | null, target: string): "remount" | "await-switch" {
  return current === target ? "remount" : "await-switch";
}
