/**
 * The lock's PIN (`lock/AppLock.tsx`): six digits of this app's own, asked when Face ID fails or the
 * phone has none, in place of the phone's passcode. Five wrong ones sign out; the PIN is then chosen
 * again after the password. Free of React and of the native modules so Node tests it.
 */

export const PIN_LENGTH = 6;
export const MAX_FAILURES = 5;

export function isPin(text: string): boolean {
  return /^[0-9]{6}$/.test(text);
}

/** What the keypad's entry becomes when a key is pressed: a digit, or "erase". */
export function pressKey(entry: string, key: string): string {
  if (key === "erase") return entry.slice(0, -1);
  if (!/^[0-9]$/.test(key) || entry.length >= PIN_LENGTH) return entry;
  return entry + key;
}

export function failuresLeft(failures: number): number {
  return Math.max(0, MAX_FAILURES - failures);
}

/** Whether that many wrong PINs in a row sign the phone out. */
export function lockedOut(failures: number): boolean {
  return failures >= MAX_FAILURES;
}

/**
 * The lock as this phone stores it for an account: off; on; or reset, when a forgotten PIN or too
 * many wrong ones signed out, and the PIN is to be chosen again once signed back in.
 */
export type LockFlag = "off" | "on" | "reset";

export const FLAG_ON = "1";
export const FLAG_RESET = "reset";

export function readFlag(stored: string | null): LockFlag {
  return stored === FLAG_ON ? "on" : stored === FLAG_RESET ? "reset" : "off";
}

/** Choosing a PIN: typed once, then again to confirm. */
export type Setup = { step: "choose" } | { step: "confirm"; first: string };

/** The next step once a whole PIN is typed: the PIN chosen, or back to the start when they differ. */
export function setupNext(setup: Setup, entered: string): { setup: Setup; pin?: string; mismatch?: boolean } {
  if (setup.step === "choose") return { setup: { step: "confirm", first: entered } };
  return entered === setup.first ? { setup: { step: "choose" }, pin: entered } : { setup: { step: "choose" }, mismatch: true };
}
