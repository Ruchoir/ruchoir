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

/** The phone's biometrics, as the settings and the lock screen name them. */
export type BiometryKind = "faceId" | "touchId" | "biometrics";

/** expo-local-authentication's `AuthenticationType` values. */
const FINGERPRINT = 1;
const FACE = 2;

/** expo-local-authentication's `SecurityLevel` from which biometrics are set up (weak, then strong). */
const BIOMETRIC_WEAK = 2;

/**
 * The word for the phone's biometrics: Face ID or Touch ID on an iPhone; on Android, where a phone
 * may have several and the system picks, "fingerprint or face".
 */
export function biometryKind(types: number[], os: "ios" | "android"): BiometryKind {
  if (os === "android") return "biometrics";
  if (types.includes(FACE)) return "faceId";
  if (types.includes(FINGERPRINT)) return "touchId";
  return "biometrics";
}

/**
 * The biometrics the lock can ask for, from the phone's enrolled level: none (null) when they are not
 * set up, and the lock is then the PIN alone. The phone's own passcode is never one of them.
 *
 * `enrolled` (expo-local-authentication's `isEnrolledAsync`) counts biometrics the phone has paused
 * after too many failures, which the level does not: without it, a paused Face ID read as no Face ID
 * at all, and the lock stopped offering it until the phone's passcode woke it.
 */
export function usableBiometry(level: number, types: number[], os: "ios" | "android", enrolled = false): BiometryKind | null {
  return level >= BIOMETRIC_WEAK || enrolled ? biometryKind(types, os) : null;
}
