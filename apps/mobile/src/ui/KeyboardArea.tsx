/**
 * A view that keeps its bottom above the keyboard: its last part (a composer, a form's button) rides
 * up with the keyboard as it opens, follows it as it is dragged down, and stays in sight while
 * typing, whatever sits above it on the screen (a header, tabs, a sheet's offset).
 *
 * The keyboard's height comes from Reanimated, frame by frame on the UI thread, so the view moves
 * with the keyboard rather than jumping before or after it. It must run to the bottom of its screen,
 * as every one in the app does: it then rises by the keyboard's whole height (`areaPadding`),
 * measuring nothing on screen, which is where React Native's `KeyboardAvoidingView` and a window
 * measure both go wrong (see `logic/keyboard.ts`). `safeBottom` keeps it clear of the home indicator
 * while the keyboard is down, in place of a `SafeAreaView` bottom edge around it, which would be
 * counted twice once the keyboard is up.
 *
 * `useAnimatedKeyboard` is marked deprecated in favour of react-native-keyboard-controller; it is
 * kept while it works, being Reanimated's own (Software Mansion) and already in Expo Go.
 */
import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { areaPadding } from "../logic/keyboard";

export function KeyboardArea({
  children,
  style,
  safeBottom = false,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  safeBottom?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const safe = safeBottom ? insets.bottom : 0;
  const lift = useAnimatedStyle(() => ({ paddingBottom: areaPadding(keyboard.height.value, safe) }));
  return <Animated.View style={[style, lift]}>{children}</Animated.View>;
}
