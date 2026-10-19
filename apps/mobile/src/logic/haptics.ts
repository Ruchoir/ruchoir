/**
 * The app's haptics, as data: one feel per kind of moment, the same everywhere (spec step 6a).
 *
 * Each pattern keeps the meaning Apple and Android give it: an impact for something that lands (a
 * menu opening under the finger, a message leaving), a selection tick while a choice changes, a
 * notification for the outcome of something the person waited for. On Android only the system's
 * haptic constants are used, never the vibrator: they follow the phone's setting and need no
 * permission; a constant the phone's Android is too old for falls back to `ANDROID_FALLBACK`, every
 * version has it. `ui/haptics.ts` plays them. An iPad has no haptic engine: it never feels anything.
 */
import type { AndroidHaptics, ImpactFeedbackStyle, NotificationFeedbackType } from "expo-haptics";

export type Feel = "menu" | "choice" | "toggleOn" | "toggleOff" | "send" | "refresh" | "success" | "failure" | "warning";

export type IosHaptic =
  | { kind: "impact"; style: `${ImpactFeedbackStyle}` }
  | { kind: "selection" }
  | { kind: "notification"; type: `${NotificationFeedbackType}` };

/** Played on Android when the feel's own constant is newer than the phone's system. */
export const ANDROID_FALLBACK = "virtual-key" satisfies `${AndroidHaptics}`;

/** What each feel plays; `ios: null` when the system already plays its own there. */
export const FEELS: Record<Feel, { ios: IosHaptic | null; android: `${AndroidHaptics}` }> = {
  /** A long press that opens something. */
  menu: { ios: { kind: "impact", style: "medium" }, android: "long-press" },
  /** A choice that changes: segmented control, chips, an answer, a reaction. */
  choice: { ios: { kind: "selection" }, android: "segment-tick" },
  /** A switch: on iOS `UISwitch` plays the system's haptic itself. */
  toggleOn: { ios: null, android: "toggle-on" },
  toggleOff: { ios: null, android: "toggle-off" },
  /** A message leaving. Medium rather than light: a light tap went unnoticed on the iPhone. */
  send: { ios: { kind: "impact", style: "medium" }, android: "confirm" },
  /** Pull to refresh, when it triggers. */
  refresh: { ios: { kind: "impact", style: "medium" }, android: "gesture-end" },
  /** Something filled in and submitted that the server accepted after a wait. */
  success: { ios: { kind: "notification", type: "success" }, android: "confirm" },
  /** Something the person did that failed. */
  failure: { ios: { kind: "notification", type: "error" }, android: "reject" },
  /** A question before going on (a name already taken). */
  warning: { ios: { kind: "notification", type: "warning" }, android: "reject" },
};
