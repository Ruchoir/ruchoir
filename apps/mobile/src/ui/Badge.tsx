import { StyleSheet, View } from "react-native";

import { useTheme } from "../theme/useTheme";
import { Text } from "./Text";

/** The ink pill with a count (`wc-badge`), or the accent one for mentions. */
export function Badge({ count, tone = "ink" }: { count: number; tone?: "ink" | "accent" }) {
  const { c } = useTheme();
  if (count <= 0) return null;
  const bg = tone === "ink" ? c.ink : c.acc;
  const fg = tone === "ink" ? c.onInk : c.onPastel;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text variant="label" style={[styles.text, { color: fg }]}>
        {count > 99 ? "99+" : String(count)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  text: { fontSize: 11, lineHeight: 13 },
});
