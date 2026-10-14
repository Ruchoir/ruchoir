/**
 * A view that keeps its bottom above the keyboard: its last part (a composer, a form's button) stays
 * in sight while typing, whatever sits above it on the screen (a header, tabs, a sheet's offset).
 *
 * In place of React Native's `KeyboardAvoidingView`, which measures itself against its parent and so
 * under-raises by the height of everything above it. This one measures itself in the window, as the
 * keyboard is, and follows the keyboard's own animation.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, LayoutAnimation, Platform, View, type KeyboardEvent, type StyleProp, type ViewStyle } from "react-native";

import { keyboardOverlap } from "../logic/keyboard";

function animate(event: KeyboardEvent) {
  if (Platform.OS !== "ios") return;
  LayoutAnimation.configureNext({
    duration: event.duration > 10 ? event.duration : 10,
    update: { duration: event.duration > 10 ? event.duration : 10, type: LayoutAnimation.Types.keyboard },
  });
}

export function KeyboardArea({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const view = useRef<View>(null);
  const [lift, setLift] = useState(0);

  useEffect(() => {
    const follow = (event: KeyboardEvent) => {
      view.current?.measureInWindow((_x, y, _width, height) => {
        animate(event);
        setLift(keyboardOverlap({ y, height }, event.endCoordinates.screenY));
      });
    };
    const drop = (event: KeyboardEvent) => {
      animate(event);
      setLift(0);
    };
    const subscriptions =
      Platform.OS === "ios"
        ? [Keyboard.addListener("keyboardWillChangeFrame", follow), Keyboard.addListener("keyboardWillHide", drop)]
        : [Keyboard.addListener("keyboardDidShow", follow), Keyboard.addListener("keyboardDidHide", drop)];
    return () => subscriptions.forEach((s) => s.remove());
  }, []);

  return (
    <View ref={view} style={[style, { paddingBottom: lift }]}>
      {children}
    </View>
  );
}
