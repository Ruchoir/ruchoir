import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../theme/useTheme";

/** A tab's page: the canvas colour under the status bar; the tab bar handles the bottom edge. */
export function TabScreen({ children, color }: { children: ReactNode; color?: string }) {
  const { c } = useTheme();
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: color ?? c.bg }]}>
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
