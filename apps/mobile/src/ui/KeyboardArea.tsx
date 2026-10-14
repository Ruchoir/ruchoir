/**
 * A view that keeps its bottom above the keyboard: its last part (a composer, a form's button) stays
 * in sight while typing, whatever sits above it on the screen (a header, tabs, a sheet's offset).
 *
 * It must run to the bottom of its screen, as every one in the app does: it then rises by the
 * keyboard's whole height (`areaPadding`), measuring nothing on screen, which is where React
 * Native's `KeyboardAvoidingView` and a window measure both go wrong (see `logic/keyboard.ts`).
 * `safeBottom` keeps it clear of the home indicator while the keyboard is down, in place of a
 * `SafeAreaView` bottom edge around it, which would be counted twice once the keyboard is up.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  Dimensions,
  Keyboard,
  LayoutAnimation,
  Platform,
  View,
  type KeyboardEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { areaPadding } from "../logic/keyboard";

function animate(event: KeyboardEvent) {
  if (Platform.OS !== "ios") return;
  const duration = event.duration > 10 ? event.duration : 10;
  LayoutAnimation.configureNext({ duration, update: { duration, type: LayoutAnimation.Types.keyboard } });
}

/** The keyboard's height from an event: none once its frame has left the screen (it is closing). */
function heightOf(event: KeyboardEvent): number {
  const { height, screenY } = event.endCoordinates;
  return screenY >= Dimensions.get("screen").height ? 0 : height;
}

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
  const [keyboard, setKeyboard] = useState(0);

  useEffect(() => {
    const follow = (event: KeyboardEvent) => {
      animate(event);
      setKeyboard(heightOf(event));
    };
    // Once it has settled: a size change missed on the way (the suggestions bar arriving when the
    // focus moves to another kind of field) is caught here.
    const settle = (event: KeyboardEvent) => setKeyboard(heightOf(event));
    const drop = (event: KeyboardEvent) => {
      animate(event);
      setKeyboard(0);
    };
    const subscriptions =
      Platform.OS === "ios"
        ? [
            Keyboard.addListener("keyboardWillChangeFrame", follow),
            Keyboard.addListener("keyboardDidShow", settle),
            Keyboard.addListener("keyboardWillHide", drop),
          ]
        : [Keyboard.addListener("keyboardDidShow", follow), Keyboard.addListener("keyboardDidHide", drop)];
    return () => subscriptions.forEach((s) => s.remove());
  }, []);

  return <View style={[style, { paddingBottom: areaPadding(keyboard, safeBottom ? insets.bottom : 0) }]}>{children}</View>;
}
