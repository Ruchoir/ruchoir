import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../theme/useTheme";
import { GuestBand } from "./GuestBanner";

/** A tab's page: the canvas colour under the status bar, a guest's band at the top; the tab bar handles the bottom edge. */
export function TabScreen({ children, color }: { children: ReactNode; color?: string }) {
  const { c } = useTheme();
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: color ?? c.bg }]}>
      <GuestBand />
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
