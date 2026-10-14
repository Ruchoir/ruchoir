/**
 * A view that keeps its bottom above the keyboard: its last part (a composer, a form's button) rides
 * up with the keyboard as it opens, follows it as it is dragged down, and stays in sight while
 * typing, whatever sits above it on the screen (a header, tabs, a sheet's offset).
 *
 * The keyboard's height comes from react-native-keyboard-controller, which reads where the keyboard
 * really is at every frame and hands it to a worklet on the UI thread, so the view moves with the
 * keyboard rather than before or after it. It must run to the bottom of its screen, as every one in
 * the app does: it then rises by the keyboard's whole height (`areaPadding`), measuring nothing on
 * screen, which is where React Native's `KeyboardAvoidingView` and a window measure both go wrong
 * (see `logic/keyboard.ts`). `safeBottom` keeps it clear of the home indicator
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
 * Reanimated's own `useAnimatedKeyboard` is not used: it guesses the keyboard's height from a curve
 * drawn for older iOS keyboards, and iOS 26's moves faster, so the composer trailed it by some 10
 * points and settled a tenth of a second after it. Reanimated deprecates it for this library.
 */
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useKeyboardHandler } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
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
  const keyboard = useKeyboardMotion();
  const rest = safeBottom ? insets.bottom : 0;
  const overlap = composer ? composerRoom(insets.bottom) - COMPOSER_GAP : 0;

  const place = useAnimatedStyle(() => {
    const { padding, shift } = areaPlacement(keyboard.height.value, rest, overlap, slide, keyboard.moving.value);
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

/**
 * The keyboard's height as it stands on screen, and whether it is on its way (opening, closing, or
 * dragged down with the list): from its first move to the frame it rests.
 */
function useKeyboardMotion() {
  const height = useSharedValue(0);
  const moving = useSharedValue(false);
  useKeyboardHandler(
    {
      onStart: () => {
        "worklet";
        moving.value = true;
      },
      onMove: (event) => {
        "worklet";
        height.value = event.height;
      },
      onInteractive: (event) => {
        "worklet";
        moving.value = true;
        height.value = event.height;
      },
      onEnd: (event) => {
        "worklet";
        height.value = event.height;
        moving.value = false;
      },
    },
    [],
  );
  return { height, moving };
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  fill: { flex: 1 },
});
