import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { lift } from "../theme/lift";
import { styleCache } from "../theme/themedStyles";
import { useTheme, useThemedStyles } from "../theme/useTheme";
import { Text } from "./Text";

type Variant = "primary" | "secondary" | "ghost" | "link" | "danger" | "dangerSoft";

/**
 * The design system's button: the primary action's colour (the ink in Ruchoir), an outline as
 * secondary, a bare ghost, a link, and danger (the deep red by day, the peach by night) for what
 * cannot be undone, and dangerSoft (the pale red well, red words and a thin red edge of the mockups'
 * delete and remove buttons). A primary button lifts onto a bee-yellow offset while pressed, as on the web,
 * unless the style is flat; disabled is the sunken grey.
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
  const theme = useTheme();
  const { c, s } = theme;
  const styles = useThemedStyles(makeStyles);
  const off = disabled || busy;
  const height = { lg: 52, md: 40, sm: 34 }[size];
  const fg = off
    ? s.disabledText
    : variant === "primary"
      ? s.onPrimary
      : variant === "danger"
        ? c.onInk
        : variant === "dangerSoft"
          ? s.danger
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
        variant === "primary" && { backgroundColor: s.primary, borderColor: s.primary },
        variant === "secondary" && { borderColor: s.edge },
        variant === "danger" && { backgroundColor: s.danger, borderColor: s.danger },
        variant === "dangerSoft" && { backgroundColor: s.dangerBg, borderColor: s.danger },
        (variant === "danger" || variant === "dangerSoft") && pressed && { opacity: 0.85 },
        variant === "ghost" && pressed && { backgroundColor: s.pressed },
        variant === "secondary" && pressed && { backgroundColor: s.sunken },
        variant === "primary" && pressed && !off && lift(theme, 4, 4, c.bee),
        off && variant !== "link" && variant !== "ghost" && { backgroundColor: s.sunken, borderColor: c.lineStrong },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.row}>
          {icon}
          {/* One line, cut with "…" when the words are longer than the button (a long instance name). */}
          <Text variant={size === "sm" ? "smallStrong" : "bodyStrong"} numberOfLines={1} style={[styles.label, { color: fg }]}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    base: {
      borderWidth: shape.hairline,
      borderColor: "transparent",
      borderRadius: shape.control,
      alignItems: "center",
      justifyContent: "center",
    },
    link: { alignSelf: "flex-start", paddingVertical: 6 },
    row: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: "100%" },
    label: { flexShrink: 1 },
  }),
);
