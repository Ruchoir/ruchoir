import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../theme/useTheme";
import { KeyboardArea } from "./KeyboardArea";
import { KeyboardForm } from "./KeyboardForm";

/** A full screen on the canvas colour, inside the safe area, scrolling and clear of the keyboard. */
export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const { c } = useTheme();
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: c.bg }]} edges={["top"]}>
      {scroll ? (
        <KeyboardForm contentContainerStyle={styles.content}>{children}</KeyboardForm>
      ) : (
        <KeyboardArea style={styles.fill} safeBottom>
          {children}
        </KeyboardArea>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 24, gap: 18 },
});
