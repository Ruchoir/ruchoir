import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { initialWindowMetrics, useSafeAreaInsets } from "react-native-safe-area-context";

import { screenInsets } from "./insets";

/**
 * The page of a full-screen modal (the event form, the scan, the file viewer): clear of the status
 * bar, and of the home indicator unless the content handles it (`bottom={false}`: a `KeyboardForm`).
 */
export function FullScreen({ children, color, bottom = true }: { children: ReactNode; color: string; bottom?: boolean }) {
  const insets = screenInsets(useSafeAreaInsets(), initialWindowMetrics?.insets ?? null);
  return <View style={[styles.fill, { backgroundColor: color, paddingTop: insets.top, paddingBottom: bottom ? insets.bottom : 0 }]}>{children}</View>;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
