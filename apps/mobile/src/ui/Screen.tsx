import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../theme/useTheme";

/** A full screen on the canvas colour, inside the safe area, scrolling and clear of the keyboard. */
export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const { c } = useTheme();
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: c.bg }]} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {scroll ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        ) : (
          children
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 24, gap: 18 },
});
