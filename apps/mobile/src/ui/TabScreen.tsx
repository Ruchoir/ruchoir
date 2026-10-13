import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../theme/useTheme";

/** A tab's page: the canvas colour under the status bar; the tab bar handles the bottom edge. */
export function TabScreen({ children }: { children: ReactNode }) {
  const { c } = useTheme();
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
