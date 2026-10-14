/**
 * A short line at the bottom of the screen that confirms or reports something done elsewhere ("Text
 * copied", "Reaction not saved"), then fades. One at a time: a new one replaces the last.
 *
 * On iOS it is drawn in a window of its own (`FullWindowOverlay`): a modal or a sheet is a native
 * screen above the app's view, and a toast drawn in that view stayed hidden under it.
 */
import { createContext, Fragment, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { Text } from "./Text";

const SHOWN_MS = 2400;

/** Above every modal and sheet on iOS; Android draws its modals in the app's own view. */
const Above = Platform.OS === "ios" ? FullWindowOverlay : Fragment;

const ToastContext = createContext<(text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const [opacity] = useState(() => new Animated.Value(0));

  const show = useCallback((text: string) => {
    setToast((prev) => ({ text, id: (prev?.id ?? 0) + 1 }));
    AccessibilityInfo.announceForAccessibility(text);
  }, []);

  useEffect(() => {
    if (!toast) return;
    Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    const timer = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setToast((prev) => (prev?.id === toast.id ? null : prev));
      });
    }, SHOWN_MS);
    return () => clearTimeout(timer);
  }, [toast, opacity]);

  return (
    <ToastContext.Provider value={show}>
      <View style={styles.fill}>
        {children}
        {toast ? (
          <Above>
            <Animated.View pointerEvents="none" style={[styles.toast, { bottom: insets.bottom + 96, opacity, backgroundColor: c.ink }]}>
              <Text variant="smallStrong" tone="onInk">
                {toast.text}
              </Text>
            </Animated.View>
          </Above>
        ) : null}
      </View>
    </ToastContext.Provider>
  );
}

/** Show a toast. */
export function useToast(): (text: string) => void {
  return useContext(ToastContext);
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  toast: { position: "absolute", alignSelf: "center", maxWidth: "86%", paddingHorizontal: 16, paddingVertical: 10, borderRadius: radius.l },
});
