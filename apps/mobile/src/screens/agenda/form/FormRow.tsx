import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { radius } from "../../../theme/tokens";
import { useTheme } from "../../../theme/useTheme";

/**
 * A line of the event form (mockup 19): a pastel tile for what it is, then its content, a hairline
 * under it. With `onPress`, the whole line opens what sets it (a sheet, a picker).
 */
export function FormRow({
  icon: Icon,
  tint,
  children,
  onPress,
  label,
  align = "center",
}: {
  icon: LucideIcon;
  tint: string;
  children: ReactNode;
  onPress?: () => void;
  /** What the line sets, for a screen reader, when it opens something. */
  label?: string;
  align?: "center" | "start";
}) {
  const { c } = useTheme();
  const content = (
    <>
      <View style={[styles.tile, { backgroundColor: tint }, align === "start" && styles.tileTop]}>
        <Icon size={18} color={c.onPastel} />
      </View>
      <View style={styles.body}>{children}</View>
    </>
  );
  const row = [styles.row, { borderBottomColor: c.line }, align === "start" && styles.rowTop];
  if (!onPress) return <View style={row}>{content}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [row, pressed && { opacity: 0.6 }]}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 56, borderBottomWidth: 1 },
  rowTop: { alignItems: "flex-start" },
  tile: { width: 32, height: 32, borderRadius: radius.s + 2, alignItems: "center", justifyContent: "center" },
  tileTop: { marginTop: 2 },
  body: { flex: 1, minWidth: 0, gap: 6 },
});
