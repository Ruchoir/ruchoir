/**
 * The design system's hard offset shadow (no blur, full opacity) under a card, a sticker or a
 * pressed button, in the shadow colour or the one given. A flat style draws none: `{}`.
 *
 * Kept free of React Native at run time so Node tests it.
 */
import type { ViewStyle } from "react-native";

import type { Theme } from "./useTheme";

export function lift(theme: Theme, x: number, y: number, color?: string): ViewStyle {
  if (theme.shape.flat) return {};
  return {
    shadowColor: color ?? theme.s.shadow,
    shadowOffset: { width: x, height: y },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: Math.max(x, y),
  };
}
