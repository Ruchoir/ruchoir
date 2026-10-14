/**
 * The Face ID lock's rules (`lock/AppLock.tsx`), kept free of React and of the native module so Node
 * tests them.
 */

/** How long the app may stay in the background before it locks: a quick look elsewhere does not. */
export const GRACE_MS = 60_000;

/**
 * Whether coming back to the app locks it: the lock is on, the app did go to the background
 * (`hiddenAt`), and longer ago than the grace. Launching locks by itself when the lock is on.
 */
export function lockOnReturn(enabled: boolean, hiddenAt: number | null, now: number): boolean {
  return enabled && hiddenAt !== null && now - hiddenAt > GRACE_MS;
}

/** What the phone unlocks with, as the settings and the lock screen name it. */
export type BiometryKind = "faceId" | "touchId" | "biometrics" | "passcode";

/** expo-local-authentication's `AuthenticationType` values. */
const FINGERPRINT = 1;
const FACE = 2;

/**
 * The word for the phone's biometrics: Face ID or Touch ID on an iPhone; on Android, where a phone
 * may have several and the system picks, "fingerprint or face"; the passcode when there are none.
 */
export function biometryKind(types: number[], os: "ios" | "android"): BiometryKind {
  if (types.length === 0) return "passcode";
  if (os === "android") return "biometrics";
  if (types.includes(FACE)) return "faceId";
  if (types.includes(FINGERPRINT)) return "touchId";
  return "biometrics";
}
