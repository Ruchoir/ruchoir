import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * Whether the keyboard is up. The composer drops the home indicator's margin while it is, since the
 * keyboard covers that edge. iOS announces the keyboard before it moves, Android once it has.
 */
export function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setShown(true));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}
