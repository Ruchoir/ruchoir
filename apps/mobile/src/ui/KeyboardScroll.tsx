/**
 * A form that scrolls and keeps the field being typed in above the keyboard.
 *
 * Put it inside a `KeyboardArea` (with the form's footer, if it has one), so its visible part ends
 * where the keyboard begins; when the keyboard comes up, or another field takes the focus while it
 * is up, it scrolls just enough for that field to show (`revealOffset`). `TextField` and
 * `SearchField` ask for it through `useRevealField`; every form of the app is written with this
 * rather than a bare `ScrollView`.
 */
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import {
  Keyboard,
  ScrollView,
  TextInput,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { revealOffset } from "../logic/keyboard";

const RevealContext = createContext<() => void>(() => {});

/** For a field: bring it into sight once it has the focus, when the keyboard is already up. */
export function useRevealField(): () => void {
  const reveal = useContext(RevealContext);
  // The keyboard's own arrival is heard by the form; a field taking the focus while it is up is not.
  return useCallback(() => {
    if (Keyboard.isVisible()) setTimeout(reveal, 60);
  }, [reveal]);
}

export function KeyboardScroll({
  children,
  style,
  contentContainerStyle,
  ...props
}: Omit<ScrollViewProps, "onScroll"> & { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const scroll = useRef<ScrollView>(null);
  const offset = useRef(0);

  const reveal = useCallback(() => {
    const field = TextInput.State.currentlyFocusedInput();
    const view = scroll.current?.getNativeScrollRef();
    if (!field || !view) return;
    field.measureInWindow((_fx, fy, _fw, fh) => {
      view.measureInWindow((_vx, vy, _vw, vh) => {
        const next = revealOffset({ y: fy, height: fh }, { y: vy, height: vh }, offset.current);
        if (next !== null) scroll.current?.scrollTo({ y: next, animated: true });
      });
    });
  }, []);

  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", reveal);
    return () => shown.remove();
  }, [reveal]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = event.nativeEvent.contentOffset.y;
  };

  return (
    <RevealContext.Provider value={reveal}>
      <ScrollView
        ref={scroll}
        style={style}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        {...props}
        onScroll={onScroll}
        contentContainerStyle={contentContainerStyle}
      >
        {children}
      </ScrollView>
    </RevealContext.Provider>
  );
}
