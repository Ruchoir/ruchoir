import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "../../ui/Text";

/** A group of settings under its monospace label, as the web's preferences pages head theirs. */
export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="label" tone="muted" style={styles.label}>
        {label.toLocaleUpperCase()}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8, paddingTop: 20 },
  label: { letterSpacing: 0.6 },
});
