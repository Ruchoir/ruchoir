import { StyleSheet, View } from "react-native";

import { useTheme } from "../theme/useTheme";
import { Text } from "./Text";

/** The pill with a count (`wc-badge`, the ink in Ruchoir, the style's badge colour), or the accent one for mentions. */
export function Badge({ count, tone = "ink" }: { count: number; tone?: "ink" | "accent" }) {
  const { c, s } = useTheme();
  if (count <= 0) return null;
  const bg = tone === "ink" ? s.badge : c.acc;
  const fg = tone === "ink" ? s.onBadge : c.onPastel;
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
