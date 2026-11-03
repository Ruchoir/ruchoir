/**
 * The design system's hard offset shadow (no blur, full opacity) under a card, a sticker or a
 * pressed button, in the shadow colour or the one given, its Android elevation the larger offset
 * unless given. A flat style draws none: `{}`.
 *
 * Kept free of React Native at run time so Node tests it.
 */
import type { ViewStyle } from "react-native";

import type { Theme } from "./useTheme";

export function lift(theme: Theme, x: number, y: number, color?: string, elevation = Math.max(x, y)): ViewStyle {
  if (theme.shape.flat) return {};
  return {
    shadowColor: color ?? theme.s.shadow,
    shadowOffset: { width: x, height: y },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation,
  };
}

/** A soft shadow under what floats over a list (a pill, a notice): none in a flat style either. */
export function soft(theme: Theme, y: number, opacity: number, blur: number): ViewStyle {
  if (theme.shape.flat) return {};
  return { shadowColor: theme.s.shadow, shadowOffset: { width: 0, height: y }, shadowOpacity: opacity, shadowRadius: blur, elevation: 4 };
}
