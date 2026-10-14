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
 * A chat ends with a `composer`, which keeps its own room for the home indicator (`composerRoom`);
 * that room goes behind the keyboard rather than above it. While its list shows, a chat should
 * `slide`: the area then moves with the keyboard without being laid out again, and takes its new size
 * once the keyboard rests, which a list anchored at its bottom (inverted) does not show. Laid out at
 * every frame, the list was re-rendered at every frame, and the composer fell behind the keyboard
 * (Reanimated holds its own updates while React commits). An empty chat need not slide: its centred
 * placeholder would jump when the area takes its size, and without a list nothing is slow to lay out.
 *
 * `useAnimatedKeyboard` is marked deprecated in favour of react-native-keyboard-controller; it is
 * kept while it works, being Reanimated's own (Software Mansion) and already in Expo Go.
 */
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { KeyboardState, useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { COMPOSER_GAP, areaPlacement, composerRoom } from "../logic/keyboard";

export function KeyboardArea({
  children,
  style,
  safeBottom = false,
  composer = false,
  slide = false,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  safeBottom?: boolean;
  composer?: boolean;
  slide?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const rest = safeBottom ? insets.bottom : 0;
  const overlap = composer ? composerRoom(insets.bottom) - COMPOSER_GAP : 0;

  const place = useAnimatedStyle(() => {
    const state = keyboard.state.value;
    const moving = state === KeyboardState.OPENING || state === KeyboardState.CLOSING;
    const { padding, shift } = areaPlacement(keyboard.height.value, rest, overlap, slide, moving);
    return composer ? { paddingBottom: padding, transform: [{ translateY: shift }] } : { paddingBottom: padding };
  });

  if (!composer) return <Animated.View style={[style, place]}>{children}</Animated.View>;
  // The area slides over whatever is above it (the header): its frame clips it there.
  return (
    <View style={[style, styles.clip]}>
      <Animated.View style={[styles.fill, place]}>{children}</Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  fill: { flex: 1 },
});
