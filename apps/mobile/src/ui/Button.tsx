import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { hairline, radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { Text } from "./Text";

type Variant = "primary" | "secondary" | "ghost" | "link";

/**
 * The design system's button: the ink as primary, an ink outline as secondary, a bare ghost, and a
 * link. A primary button lifts onto a bee-yellow offset while pressed, as on the web; disabled is the
 * sunken grey.
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  size = "lg",
  disabled,
  busy,
  icon,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  size?: "lg" | "md" | "sm";
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { c, s } = useTheme();
  const off = disabled || busy;
  const height = { lg: 52, md: 40, sm: 34 }[size];
  const fg = off
    ? s.disabledText
    : variant === "primary"
      ? c.onInk
      : variant === "link"
        ? s.link
        : variant === "ghost"
          ? c.body
          : c.ink;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      hitSlop={variant === "link" ? 8 : undefined}
      style={({ pressed }) => [
        variant === "link" ? styles.link : [styles.base, { height, paddingHorizontal: size === "sm" ? 12 : 20 }],
        variant === "primary" && { backgroundColor: c.ink, borderColor: c.ink },
        variant === "secondary" && { borderColor: c.ink },
        variant === "ghost" && pressed && { backgroundColor: s.pressed },
        variant === "secondary" && pressed && { backgroundColor: s.sunken },
        variant === "primary" && pressed && !off && styles.lifted,
        variant === "primary" && pressed && !off && { shadowColor: c.bee },
        off && variant !== "link" && variant !== "ghost" && { backgroundColor: s.sunken, borderColor: c.lineStrong },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.row}>
          {icon}
          <Text variant={size === "sm" ? "smallStrong" : "bodyStrong"} style={{ color: fg }}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: hairline,
    borderColor: "transparent",
    borderRadius: radius.m,
    alignItems: "center",
    justifyContent: "center",
  },
  link: { alignSelf: "flex-start", paddingVertical: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  lifted: { shadowOffset: { width: 4, height: 4 }, shadowOpacity: 1, shadowRadius: 0, elevation: 4 },
});
