import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { lift } from "../../theme/lift";
import { useTheme } from "../../theme/useTheme";

/**
 * A pastel tile edged in ink on a hard offset shadow, a little askew: the design system's sticker
 * (`EmptyState` draws its icon this way), at the size of the welcome's and the tutorial's pictures.
 * A flat style draws it square to the page, on a grey edge, without the offset.
 */
export function Sticker({
  icon: Icon,
  color,
  size,
  rotate = 0,
  style,
  children,
}: {
  icon?: LucideIcon;
  color: string;
  size: number;
  rotate?: number;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const theme = useTheme();
  const { c, s, shape } = theme;
  const offset = Math.max(3, Math.round(size / 24));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: size > 120 ? shape.radius.l * 2 : shape.radius.l,
          backgroundColor: color,
          borderColor: shape.flat ? s.edge : c.onPastel,
          borderWidth: shape.edgeWidth,
          transform: [{ rotate: `${shape.flat ? 0 : rotate}deg` }],
        },
        lift(theme, offset, offset),
        style,
      ]}
    >
      {Icon ? <Icon size={Math.round(size * 0.38)} color={c.onPastel} strokeWidth={2} /> : children}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center" },
});
