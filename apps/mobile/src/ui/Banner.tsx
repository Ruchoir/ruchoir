import { StyleSheet, View } from "react-native";

import { styleCache } from "../theme/themedStyles";
import { useTheme, useThemedStyles } from "../theme/useTheme";
import { Text } from "./Text";

/** A message in a tinted box: a refusal (danger) or a confirmation (success). */
export function Banner({ tone, text }: { tone: "danger" | "success"; text: string }) {
  const { s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const colors =
    tone === "danger"
      ? { backgroundColor: s.dangerBg, borderColor: s.danger }
      : { backgroundColor: s.successBg, borderColor: s.success };
  return (
    <View accessibilityRole="alert" style={[styles.box, colors]}>
      <Text variant="small">{text}</Text>
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    box: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: shape.radius.m, borderWidth: shape.hairline },
  }),
);
