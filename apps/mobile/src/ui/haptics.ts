/**
 * Plays one of the app's feels (`logic/haptics.ts`). Never throws and is never awaited: a phone
 * without a haptic engine, or with haptics turned off in its settings, simply feels nothing.
 */
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

import { ANDROID_FALLBACK, FEELS, type Feel } from "../logic/haptics";

export type { Feel };

export function feel(f: Feel): void {
  const row = FEELS[f];
  if (Platform.OS === "android") {
    // A constant newer than the phone's Android throws: the one every version has plays instead.
    Haptics.performAndroidHapticsAsync(row.android as Haptics.AndroidHaptics).catch(() =>
      Haptics.performAndroidHapticsAsync(ANDROID_FALLBACK as Haptics.AndroidHaptics).catch(() => {}),
    );
    return;
  }
  const ios = row.ios;
  if (!ios) return;
  const played =
    ios.kind === "impact"
      ? Haptics.impactAsync(ios.style as Haptics.ImpactFeedbackStyle)
      : ios.kind === "selection"
        ? Haptics.selectionAsync()
        : Haptics.notificationAsync(ios.type as Haptics.NotificationFeedbackType);
  played.catch(() => {});
}
